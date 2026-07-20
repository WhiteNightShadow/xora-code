import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalizeJcsBytes } from "./jcs.js";

export interface SidecarArtifact {
  url: string;
  sha256: string;
  size: number;
}

export interface SidecarManifestPayload {
  schemaVersion: 1;
  product: "xora-grok-sidecar";
  sequence: number;
  channel: "stable" | "beta" | "nightly";
  version: string;
  releasedAt: string;
  homeCompatEpoch: number;
  patchSha256: string;
  appCompatibility: {
    minimumVersion: string;
    maximumVersion?: string;
  };
  sidecarLockSha256: string;
  upstream: {
    commit: string;
    sourceRevision: string;
  };
  acp: {
    transport: "stdio";
    command: string[];
    fixtureSha256: string;
  };
  artifacts: Record<string, SidecarArtifact>;
}

export interface ManifestSignature {
  keyId: string;
  algorithm: "ed25519";
  /** Standard base64-encoded 64-byte Ed25519 signature. */
  signature: string;
}

export interface SignedSidecarManifest {
  payload: SidecarManifestPayload;
  signatures: ManifestSignature[];
}

export interface TrustedManifestKey {
  keyId: string;
  algorithm: "ed25519";
  /** PEM, a base64 raw 32-byte public key, Buffer, or public KeyObject. */
  publicKey: string | Buffer | KeyObject;
  notBefore?: string;
  notAfter?: string;
  revoked?: boolean;
}

export interface ManifestVerificationOptions {
  now?: Date;
  minimumSequence?: number;
  expectedChannel?: SidecarManifestPayload["channel"];
  requiredSignatures?: number;
}

export interface ManifestVerificationResult {
  payload: SidecarManifestPayload;
  validKeyIds: string[];
  canonicalPayload: Buffer;
}

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RAW_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertIsoDate(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${path} must be an ISO-8601 timestamp`);
  }
}

function assertSemver(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a SemVer version`);
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`${path} must be a SemVer version`);
  if ([match[1], match[2], match[3]].some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`${path} core numbers must be safe integers`);
  }
  if (match[4]?.split(".").some((part) => /^0\d+$/u.test(part))) {
    throw new Error(`${path} numeric prerelease identifiers must not contain leading zeroes`);
  }
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver {
  assertSemver(value, "version");
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`invalid SemVer ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length < rightPart.length ? -1 : 1;
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** SemVer precedence comparison; build metadata does not affect precedence. */
export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  for (const field of ["major", "minor", "patch"] as const) {
    if (parsedLeft[field] !== parsedRight[field]) {
      return parsedLeft[field] < parsedRight[field] ? -1 : 1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function isAppVersionCompatible(
  appVersion: string,
  compatibility: SidecarManifestPayload["appCompatibility"],
): boolean {
  assertSemver(appVersion, "app version");
  return (
    compareSemver(appVersion, compatibility.minimumVersion) >= 0 &&
    (compatibility.maximumVersion === undefined ||
      compareSemver(appVersion, compatibility.maximumVersion) <= 0)
  );
}

export function validateSidecarManifestPayload(input: unknown): SidecarManifestPayload {
  assertObject(input, "$manifest.payload");
  if (input.schemaVersion !== 1) throw new Error("manifest payload schemaVersion must be 1");
  if (input.product !== "xora-grok-sidecar") throw new Error("unexpected manifest product");
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) {
    throw new Error("manifest sequence must be a positive safe integer");
  }
  if (input.channel !== "stable" && input.channel !== "beta" && input.channel !== "nightly") {
    throw new Error("manifest channel is invalid");
  }
  assertSemver(input.version, "manifest version");
  assertIsoDate(input.releasedAt, "releasedAt");
  if (!Number.isSafeInteger(input.homeCompatEpoch) || Number(input.homeCompatEpoch) < 1) {
    throw new Error("homeCompatEpoch must be a positive safe integer");
  }
  if (typeof input.patchSha256 !== "string" || !SHA256_PATTERN.test(input.patchSha256)) {
    throw new Error("patchSha256 must be a lowercase SHA-256 digest");
  }
  assertObject(input.appCompatibility, "appCompatibility");
  assertSemver(input.appCompatibility.minimumVersion, "appCompatibility.minimumVersion");
  if (input.appCompatibility.maximumVersion !== undefined) {
    assertSemver(input.appCompatibility.maximumVersion, "appCompatibility.maximumVersion");
    if (
      compareSemver(
        input.appCompatibility.minimumVersion as string,
        input.appCompatibility.maximumVersion as string,
      ) > 0
    ) {
      throw new Error("appCompatibility maximumVersion must not precede minimumVersion");
    }
  }
  if (typeof input.sidecarLockSha256 !== "string" || !SHA256_PATTERN.test(input.sidecarLockSha256)) {
    throw new Error("sidecarLockSha256 must be a lowercase SHA-256 digest");
  }

  assertObject(input.upstream, "upstream");
  if (
    typeof input.upstream.commit !== "string" ||
    typeof input.upstream.sourceRevision !== "string" ||
    !SHA1_PATTERN.test(input.upstream.commit) ||
    !SHA1_PATTERN.test(input.upstream.sourceRevision)
  ) {
    throw new Error("upstream revisions must be full lowercase SHA-1 values");
  }

  assertObject(input.acp, "acp");
  if (input.acp.transport !== "stdio") throw new Error("ACP transport must be stdio");
  if (!Array.isArray(input.acp.command) || !input.acp.command.every((item) => typeof item === "string")) {
    throw new Error("ACP command must be a string array");
  }
  const expectedAcpCommand = [
    "--no-auto-update",
    "--cwd",
    "<root>",
    "agent",
    "--no-leader",
    "stdio",
  ];
  if (input.acp.command.join("\u0000") !== expectedAcpCommand.join("\u0000")) {
    throw new Error("ACP command must bind <root> and launch the independent no-leader stdio sidecar");
  }
  if (typeof input.acp.fixtureSha256 !== "string" || !SHA256_PATTERN.test(input.acp.fixtureSha256)) {
    throw new Error("acp.fixtureSha256 must be a lowercase SHA-256 digest");
  }

  assertObject(input.artifacts, "artifacts");
  const artifactEntries = Object.entries(input.artifacts);
  if (artifactEntries.length === 0) throw new Error("manifest must contain at least one artifact");
  const artifacts: Record<string, SidecarArtifact> = {};
  for (const [target, value] of artifactEntries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(target)) throw new Error(`invalid artifact target ${target}`);
    assertObject(value, `artifacts.${target}`);
    if (typeof value.url !== "string") throw new Error(`artifacts.${target}.url must be a string`);
    const url = new URL(value.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error(`artifacts.${target}.url must be a credential-free HTTPS URL`);
    }
    if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
      throw new Error(`artifacts.${target}.sha256 must be a lowercase SHA-256 digest`);
    }
    if (!Number.isSafeInteger(value.size) || Number(value.size) <= 0) {
      throw new Error(`artifacts.${target}.size must be a positive safe integer`);
    }
    artifacts[target] = { url: value.url, sha256: value.sha256, size: Number(value.size) };
  }

  return {
    schemaVersion: 1,
    product: "xora-grok-sidecar",
    sequence: Number(input.sequence),
    channel: input.channel,
    version: input.version,
    releasedAt: input.releasedAt,
    homeCompatEpoch: Number(input.homeCompatEpoch),
    patchSha256: input.patchSha256,
    appCompatibility: {
      minimumVersion: input.appCompatibility.minimumVersion as string,
      ...(input.appCompatibility.maximumVersion === undefined
        ? {}
        : { maximumVersion: input.appCompatibility.maximumVersion as string }),
    },
    sidecarLockSha256: input.sidecarLockSha256,
    upstream: {
      commit: input.upstream.commit as string,
      sourceRevision: input.upstream.sourceRevision as string,
    },
    acp: {
      transport: "stdio",
      command: [...(input.acp.command as string[])],
      fixtureSha256: input.acp.fixtureSha256 as string,
    },
    artifacts,
  };
}

function decodeBase64(value: string, expectedBytes: number, path: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${path} must be standard padded base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes) throw new Error(`${path} must decode to ${expectedBytes} bytes`);
  return decoded;
}

function publicKeyObject(input: TrustedManifestKey["publicKey"]): KeyObject {
  if (typeof input === "string" && input.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(input);
  }
  if (typeof input === "object" && "type" in input && input.type === "public") {
    return input as KeyObject;
  }
  const raw = Buffer.isBuffer(input)
    ? input
    : decodeBase64(input as string, 32, "trusted public key");
  if (raw.length !== 32) throw new Error("raw Ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([RAW_ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function keyUsable(key: TrustedManifestKey, now: Date): boolean {
  if (key.revoked) return false;
  if (key.notBefore && Date.parse(key.notBefore) > now.getTime()) return false;
  if (key.notAfter && Date.parse(key.notAfter) < now.getTime()) return false;
  return true;
}

export function verifySignedSidecarManifest(
  input: unknown,
  trustedKeys: readonly TrustedManifestKey[],
  options: ManifestVerificationOptions = {},
): ManifestVerificationResult {
  assertObject(input, "$manifest");
  const payload = validateSidecarManifestPayload(input.payload);
  if (!Array.isArray(input.signatures) || input.signatures.length === 0) {
    throw new Error("manifest must contain signatures");
  }
  if (options.minimumSequence !== undefined && payload.sequence < options.minimumSequence) {
    throw new Error(`manifest sequence ${payload.sequence} is below anti-rollback floor ${options.minimumSequence}`);
  }
  if (options.expectedChannel && payload.channel !== options.expectedChannel) {
    throw new Error(`manifest channel ${payload.channel} does not match ${options.expectedChannel}`);
  }

  const keyMap = new Map<string, TrustedManifestKey>();
  for (const key of trustedKeys) {
    if (!KEY_ID_PATTERN.test(key.keyId)) throw new Error(`invalid trusted key id ${key.keyId}`);
    if (key.algorithm !== "ed25519") throw new Error(`unsupported key algorithm for ${key.keyId}`);
    if (keyMap.has(key.keyId)) throw new Error(`duplicate trusted key id ${key.keyId}`);
    if (key.notBefore) assertIsoDate(key.notBefore, `trusted key ${key.keyId}.notBefore`);
    if (key.notAfter) assertIsoDate(key.notAfter, `trusted key ${key.keyId}.notAfter`);
    keyMap.set(key.keyId, key);
  }

  const seenSignatures = new Set<string>();
  const validKeyIds: string[] = [];
  // Verify exactly what was received. Validation may normalize field order,
  // but must never silently remove unsigned attacker-controlled fields.
  const canonicalPayload = canonicalizeJcsBytes(input.payload);
  const now = options.now ?? new Date();
  for (const candidate of input.signatures) {
    assertObject(candidate, "manifest signature");
    if (typeof candidate.keyId !== "string" || !KEY_ID_PATTERN.test(candidate.keyId)) {
      throw new Error("manifest signature has an invalid key id");
    }
    if (seenSignatures.has(candidate.keyId)) throw new Error(`duplicate signature for ${candidate.keyId}`);
    seenSignatures.add(candidate.keyId);
    if (candidate.algorithm !== "ed25519" || typeof candidate.signature !== "string") {
      throw new Error(`invalid signature metadata for ${candidate.keyId}`);
    }
    const key = keyMap.get(candidate.keyId);
    if (!key || !keyUsable(key, now)) continue;
    const signature = decodeBase64(candidate.signature, 64, `signature ${candidate.keyId}`);
    if (verify(null, canonicalPayload, publicKeyObject(key.publicKey), signature)) {
      validKeyIds.push(candidate.keyId);
    }
  }

  const required = options.requiredSignatures ?? 1;
  if (!Number.isSafeInteger(required) || required < 1) throw new Error("requiredSignatures must be positive");
  if (validKeyIds.length < required) {
    throw new Error(`manifest has ${validKeyIds.length} valid signature(s); ${required} required`);
  }
  return { payload, validKeyIds, canonicalPayload };
}

export function sha256Hex(data: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(data).digest("hex");
}

export function verifySha256(data: string | NodeJS.ArrayBufferView, expected: string): boolean {
  if (!SHA256_PATTERN.test(expected)) return false;
  const actual = Buffer.from(sha256Hex(data), "hex");
  const wanted = Buffer.from(expected, "hex");
  return timingSafeEqual(actual, wanted);
}
