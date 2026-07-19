import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  compareSemver,
  isAppVersionCompatible,
  verifySignedSidecarManifest,
  type SidecarArtifact,
  type SidecarManifestPayload,
  type TrustedManifestKey,
} from "./manifest.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type SidecarUpdateErrorCode =
  | "busy"
  | "state"
  | "manifest"
  | "sequence"
  | "compatibility"
  | "platform"
  | "download"
  | "integrity"
  | "staging"
  | "platform-signature"
  | "version-smoke"
  | "acp-smoke"
  | "activation";

export class SidecarUpdateError extends Error {
  readonly code: SidecarUpdateErrorCode;
  readonly causeValue?: unknown;

  constructor(code: SidecarUpdateErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.name = "SidecarUpdateError";
    this.code = code;
    this.causeValue = causeValue;
  }
}

export interface InstalledSidecarRelease {
  version: string;
  sequence: number;
  channel: SidecarManifestPayload["channel"];
  target: string;
  artifactSha256: string;
  artifactSize: number;
  sidecarLockSha256: string;
  patchSha256: string;
  acpFixtureSha256: string;
  homeCompatEpoch: number;
  installedAt: string;
}

export interface SidecarUpdateState {
  schemaVersion: 1;
  highestSequence: number;
  homeCompatEpoch: number;
  active?: InstalledSidecarRelease;
  previous?: InstalledSidecarRelease;
}

export interface StagingDownloadRequest {
  url: string;
  destinationPath: string;
  expectedSize: number;
  expectedSha256: string;
  signal?: AbortSignal;
}

/** Implemented by the host; production may use fetch, tests use local bytes. */
export interface StagingDownloader {
  download(request: StagingDownloadRequest): Promise<void>;
}

export interface ArtifactStagingRequest {
  artifactPath: string;
  destinationDirectory: string;
  binaryName: "grok" | "grok.exe";
  target: string;
  manifest: SidecarManifestPayload;
}

/** Extracts/materializes the already-hash-verified artifact into staging. */
export interface SidecarArtifactStager {
  stage(request: ArtifactStagingRequest): Promise<void>;
}

export interface PlatformSignatureRequest {
  binaryPath: string;
  target: string;
  artifact: SidecarArtifact;
  manifest: SidecarManifestPayload;
}

export type PlatformSignatureVerifier = (request: PlatformSignatureRequest) => Promise<void>;

export interface VersionSmokeRequest {
  binaryPath: string;
  args: readonly ["--version"];
  expectedVersion: string;
}

/** Returns the parsed exact semantic version reported by `grok --version`. */
export type VersionSmoke = (request: VersionSmokeRequest) => Promise<string>;

export interface AcpInitializeSmokeRequest {
  binaryPath: string;
  args: readonly string[];
  workspaceRoot: string;
  fixtureSha256: string;
}

/** Must launch ACP, complete initialize, validate the fixture, then exit. */
export type AcpInitializeSmoke = (request: AcpInitializeSmokeRequest) => Promise<void>;

export type ActivationPhase =
  | "before-retire-previous"
  | "after-retire-previous"
  | "after-move-active"
  | "after-promote-candidate"
  | "before-state-commit";

export interface SidecarInstallerOptions {
  /** Test/telemetry seam. Throwing simulates an activation failure. */
  activationHook?: (phase: ActivationPhase) => Promise<void> | void;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function validateRelease(value: unknown, path: string): InstalledSidecarRelease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SidecarUpdateError("state", `${path} must be an object`);
  }
  const release = value as Record<string, unknown>;
  const stringFields = [
    "version",
    "channel",
    "target",
    "artifactSha256",
    "sidecarLockSha256",
    "patchSha256",
    "acpFixtureSha256",
    "installedAt",
  ] as const;
  for (const field of stringFields) {
    if (typeof release[field] !== "string" || release[field] === "") {
      throw new SidecarUpdateError("state", `${path}.${field} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(release.sequence) || Number(release.sequence) < 0) {
    throw new SidecarUpdateError("state", `${path}.sequence must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(release.artifactSize) || Number(release.artifactSize) < 0) {
    throw new SidecarUpdateError("state", `${path}.artifactSize must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(release.homeCompatEpoch) || Number(release.homeCompatEpoch) < 1) {
    throw new SidecarUpdateError("state", `${path}.homeCompatEpoch must be positive`);
  }
  if (release.channel !== "stable" && release.channel !== "beta" && release.channel !== "nightly") {
    throw new SidecarUpdateError("state", `${path}.channel is invalid`);
  }
  try {
    compareSemver(release.version as string, release.version as string);
  } catch (error) {
    throw new SidecarUpdateError("state", `${path}.version is invalid.`, error);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(release.target as string)) {
    throw new SidecarUpdateError("state", `${path}.target is invalid.`);
  }
  for (const field of [
    "artifactSha256",
    "sidecarLockSha256",
    "patchSha256",
    "acpFixtureSha256",
  ] as const) {
    if (!SHA256_PATTERN.test(release[field] as string)) {
      throw new SidecarUpdateError("state", `${path}.${field} must be a lowercase SHA-256 digest.`);
    }
  }
  if (!Number.isFinite(Date.parse(release.installedAt as string))) {
    throw new SidecarUpdateError("state", `${path}.installedAt must be an ISO timestamp.`);
  }
  return release as unknown as InstalledSidecarRelease;
}

function statesEqual(left: SidecarUpdateState, right: SidecarUpdateState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class SidecarActivationError extends SidecarUpdateError {
  readonly rollbackComplete: boolean;
  readonly rollbackErrors: readonly unknown[];

  constructor(causeValue: unknown, rollbackErrors: readonly unknown[]) {
    super(
      "activation",
      rollbackErrors.length === 0
        ? "Sidecar activation failed and was rolled back."
        : "Sidecar activation failed and rollback was incomplete; staging was retained.",
      causeValue,
    );
    this.name = "SidecarActivationError";
    this.rollbackComplete = rollbackErrors.length === 0;
    this.rollbackErrors = rollbackErrors;
  }
}

/** Owns only component storage and atomic directory rotation; it never touches embedded/. */
export class SidecarInstaller {
  readonly root: string;
  readonly embeddedPath: string;
  readonly activePath: string;
  readonly previousPath: string;
  readonly statePath: string;
  readonly #stagingRoot: string;
  readonly #lockPath: string;
  readonly #activationHook: SidecarInstallerOptions["activationHook"] | undefined;

  constructor(root: string, options: SidecarInstallerOptions = {}) {
    if (!root) throw new Error("Sidecar component root must be non-empty.");
    this.root = resolve(root);
    this.embeddedPath = join(this.root, "embedded");
    this.activePath = join(this.root, "active");
    this.previousPath = join(this.root, "previous");
    this.statePath = join(this.root, "update-state.json");
    this.#stagingRoot = join(this.root, ".staging");
    this.#lockPath = join(this.root, ".update.lock");
    this.#activationHook = options.activationHook;
  }

  async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SidecarUpdateError("busy", "Another sidecar update is already running.");
      }
      throw error;
    }
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.#lockPath, { force: true }).catch(() => undefined);
    }
  }

  async createStage(): Promise<string> {
    await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
    return mkdtemp(join(this.#stagingRoot, "update-"));
  }

  async discardStage(stagePath: string): Promise<void> {
    if (!isWithin(this.#stagingRoot, stagePath) || resolve(stagePath) === resolve(this.#stagingRoot)) {
      throw new SidecarUpdateError("staging", "Refusing to remove a path outside the staging root.");
    }
    await rm(stagePath, { recursive: true, force: true });
  }

  async readState(embeddedRelease: InstalledSidecarRelease): Promise<SidecarUpdateState> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (isNotFound(error)) {
        return {
          schemaVersion: 1,
          highestSequence: embeddedRelease.sequence,
          homeCompatEpoch: embeddedRelease.homeCompatEpoch,
        };
      }
      if (error instanceof SyntaxError) {
        throw new SidecarUpdateError("state", "Sidecar update state contains invalid JSON.", error);
      }
      throw error;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SidecarUpdateError("state", "Sidecar update state must be an object.");
    }
    const value = parsed as Record<string, unknown>;
    if (value.schemaVersion !== 1) throw new SidecarUpdateError("state", "Unsupported update state schema.");
    if (!Number.isSafeInteger(value.highestSequence) || Number(value.highestSequence) < 0) {
      throw new SidecarUpdateError("state", "Invalid highestSequence in update state.");
    }
    if (!Number.isSafeInteger(value.homeCompatEpoch) || Number(value.homeCompatEpoch) < 1) {
      throw new SidecarUpdateError("state", "Invalid homeCompatEpoch in update state.");
    }
    const active = value.active === undefined ? undefined : validateRelease(value.active, "state.active");
    const previous = value.previous === undefined ? undefined : validateRelease(value.previous, "state.previous");
    const highestSequence = Number(value.highestSequence);
    if ((active && active.sequence > highestSequence) || (previous && previous.sequence > highestSequence)) {
      throw new SidecarUpdateError("state", "Release sequence exceeds the persisted anti-rollback floor.");
    }
    return {
      schemaVersion: 1,
      highestSequence,
      homeCompatEpoch: Number(value.homeCompatEpoch),
      ...(active ? { active } : {}),
      ...(previous ? { previous } : {}),
    };
  }

  async assertLayout(
    state: SidecarUpdateState,
    binaryName: "grok" | "grok.exe",
  ): Promise<void> {
    const verifyInstalledBinary = async (directory: string, label: string): Promise<void> => {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(join(directory, binaryName));
      } catch (error) {
        throw new SidecarUpdateError("state", `The ${label} sidecar binary is missing.`, error);
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new SidecarUpdateError("state", `The ${label} sidecar binary must be a regular file.`);
      }
    };
    await verifyInstalledBinary(this.embeddedPath, "embedded fallback");
    const activeExists = await pathExists(this.activePath);
    const previousExists = await pathExists(this.previousPath);
    if (activeExists !== Boolean(state.active) || previousExists !== Boolean(state.previous)) {
      throw new SidecarUpdateError("state", "Sidecar directories do not match update-state.json.");
    }
    if (state.active) await verifyInstalledBinary(this.activePath, "active");
    if (state.previous) await verifyInstalledBinary(this.previousPath, "previous");
  }

  async assertStagedBinary(
    candidateDirectory: string,
    binaryName: "grok" | "grok.exe",
  ): Promise<string> {
    const candidateInfo = await lstat(candidateDirectory);
    if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
      throw new SidecarUpdateError("staging", "Candidate installation must be a real directory.");
    }
    const binaryPath = join(candidateDirectory, binaryName);
    const binaryInfo = await lstat(binaryPath);
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) {
      throw new SidecarUpdateError("staging", "Staged sidecar binary must be a regular file.");
    }
    const [candidateRealPath, binaryRealPath] = await Promise.all([
      realpath(candidateDirectory),
      realpath(binaryPath),
    ]);
    if (!isWithin(candidateRealPath, binaryRealPath)) {
      throw new SidecarUpdateError("staging", "Staged binary escapes the candidate directory.");
    }
    if (binaryName !== "grok.exe") await chmod(binaryPath, 0o755);
    return binaryPath;
  }

  async writeReleaseMetadata(
    candidateDirectory: string,
    release: InstalledSidecarRelease,
  ): Promise<void> {
    await writeJsonAtomic(join(candidateDirectory, "release.json"), release);
  }

  async activate(
    stagePath: string,
    candidateDirectory: string,
    expectedState: SidecarUpdateState,
    nextState: SidecarUpdateState,
  ): Promise<void> {
    if (!isWithin(stagePath, candidateDirectory)) {
      throw new SidecarUpdateError("activation", "Candidate directory is outside its staging transaction.");
    }
    const persistedState = await this.readState({
      version: "embedded",
      sequence: expectedState.highestSequence,
      channel: "stable",
      target: "embedded",
      artifactSha256: "embedded",
      artifactSize: 0,
      sidecarLockSha256: "embedded",
      patchSha256: "embedded",
      acpFixtureSha256: "embedded",
      homeCompatEpoch: expectedState.homeCompatEpoch,
      installedAt: "embedded",
    });
    if (!statesEqual(persistedState, expectedState)) {
      throw new SidecarUpdateError("state", "Update state changed during staging.");
    }

    const retiredPreviousPath = join(stagePath, "retired-previous");
    let retiredPrevious = false;
    let movedActive = false;
    let promotedCandidate = false;
    let committed = false;
    try {
      await this.#activationHook?.("before-retire-previous");
      if (await pathExists(this.previousPath)) {
        await rename(this.previousPath, retiredPreviousPath);
        retiredPrevious = true;
      }
      await this.#activationHook?.("after-retire-previous");
      if (await pathExists(this.activePath)) {
        await rename(this.activePath, this.previousPath);
        movedActive = true;
      }
      await this.#activationHook?.("after-move-active");
      await rename(candidateDirectory, this.activePath);
      promotedCandidate = true;
      await this.#activationHook?.("after-promote-candidate");
      await this.#activationHook?.("before-state-commit");
      await writeJsonAtomic(this.statePath, nextState);
      committed = true;
    } catch (error) {
      if (committed) throw error;
      const rollbackErrors: unknown[] = [];
      if (promotedCandidate) {
        await rename(this.activePath, candidateDirectory).catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (movedActive) {
        await rename(this.previousPath, this.activePath).catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (retiredPrevious) {
        await rename(retiredPreviousPath, this.previousPath).catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      throw new SidecarActivationError(error, rollbackErrors);
    }

    if (committed && retiredPrevious) {
      await rm(retiredPreviousPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Restores previous, or the immutable embedded baseline on the first update. */
  async rollbackToPrevious(embeddedRelease: InstalledSidecarRelease): Promise<InstalledSidecarRelease> {
    return this.withUpdateLock(async () => {
      const state = await this.readState(embeddedRelease);
      if (!state.active) {
        throw new SidecarUpdateError("state", "No active Grok sidecar update is available for rollback.");
      }
      if (state.homeCompatEpoch !== state.active.homeCompatEpoch || state.homeCompatEpoch !== embeddedRelease.homeCompatEpoch) {
        throw new SidecarUpdateError("compatibility", "Rollback across homeCompatEpoch is forbidden.");
      }
      const binaryName = state.active.target.startsWith("win32-") ? "grok.exe" : "grok";
      await this.assertLayout(state, binaryName);

      if (!state.previous) {
        const stagePath = await this.createStage();
        const retiredActive = join(stagePath, "retired-active");
        let activeMoved = false;
        let parkedAsPrevious = false;
        try {
          await rename(this.activePath, retiredActive);
          activeMoved = true;
          await rename(retiredActive, this.previousPath);
          activeMoved = false;
          parkedAsPrevious = true;
          const nextState: SidecarUpdateState = {
            schemaVersion: 1,
            highestSequence: state.highestSequence,
            homeCompatEpoch: state.homeCompatEpoch,
            previous: state.active,
          };
          await writeJsonAtomic(this.statePath, nextState);
          await this.discardStage(stagePath).catch(() => undefined);
          return embeddedRelease;
        } catch (error) {
          const rollbackErrors: unknown[] = [];
          if (parkedAsPrevious) {
            await rename(this.previousPath, this.activePath).catch((candidate) => rollbackErrors.push(candidate));
          } else if (activeMoved) {
            await rename(retiredActive, this.activePath).catch((candidate) => rollbackErrors.push(candidate));
          }
          if (rollbackErrors.length === 0) await this.discardStage(stagePath).catch(() => undefined);
          throw new SidecarActivationError(error, rollbackErrors);
        }
      }

      if (state.active.homeCompatEpoch !== state.previous.homeCompatEpoch) {
        throw new SidecarUpdateError("compatibility", "Rollback across homeCompatEpoch is forbidden.");
      }
      const stagePath = await this.createStage();
      const retiredActive = join(stagePath, "retired-active");
      let activeMoved = false;
      let previousPromoted = false;
      let swapComplete = false;
      try {
        await rename(this.activePath, retiredActive);
        activeMoved = true;
        await rename(this.previousPath, this.activePath);
        previousPromoted = true;
        await rename(retiredActive, this.previousPath);
        activeMoved = false;
        swapComplete = true;
        const nextState: SidecarUpdateState = {
          ...state,
          active: state.previous,
          previous: state.active,
        };
        await writeJsonAtomic(this.statePath, nextState);
        await this.discardStage(stagePath).catch(() => undefined);
        return state.previous;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (swapComplete) {
          const promotedPrevious = join(stagePath, "promoted-previous");
          await rename(this.activePath, promotedPrevious).catch((candidate) => rollbackErrors.push(candidate));
          await rename(this.previousPath, this.activePath).catch((candidate) => rollbackErrors.push(candidate));
          await rename(promotedPrevious, this.previousPath).catch((candidate) => rollbackErrors.push(candidate));
        } else {
          if (previousPromoted && await pathExists(this.activePath)) {
            await rename(this.activePath, this.previousPath).catch((candidate) => rollbackErrors.push(candidate));
          }
          if (activeMoved && await pathExists(retiredActive)) {
            await rename(retiredActive, this.activePath).catch((candidate) => rollbackErrors.push(candidate));
          }
        }
        if (rollbackErrors.length === 0) await this.discardStage(stagePath).catch(() => undefined);
        throw new SidecarActivationError(error, rollbackErrors);
      }
    });
  }
}

export interface SidecarUpdateManagerOptions {
  installer: SidecarInstaller;
  downloader: StagingDownloader;
  artifactStager: SidecarArtifactStager;
  platformSignatureVerifier: PlatformSignatureVerifier;
  versionSmoke: VersionSmoke;
  acpInitializeSmoke: AcpInitializeSmoke;
  trustedKeys: readonly TrustedManifestKey[];
  embeddedRelease: InstalledSidecarRelease;
  appVersion: string;
  channel: SidecarManifestPayload["channel"];
  target: string;
  homeCompatEpoch: number;
  expectedAcpFixtureSha256: string;
  acceptedPatchSha256: readonly string[];
  smokeWorkspaceRoot: string;
  requiredSignatures?: number;
  now?: () => Date;
}

export type SidecarUpdateResult =
  | { status: "up-to-date"; release: InstalledSidecarRelease }
  | { status: "installed"; release: InstalledSidecarRelease; previous?: InstalledSidecarRelease };

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function currentMatches(
  current: InstalledSidecarRelease,
  payload: SidecarManifestPayload,
  artifact: SidecarArtifact,
  target: string,
): boolean {
  return (
    current.version === payload.version &&
    current.target === target &&
    current.artifactSha256 === artifact.sha256 &&
    current.artifactSize === artifact.size &&
    current.sidecarLockSha256 === payload.sidecarLockSha256 &&
    current.patchSha256 === payload.patchSha256 &&
    current.acpFixtureSha256 === payload.acp.fixtureSha256
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Sidecar update aborted.");
  }
}

export class SidecarUpdateManager {
  readonly #options: SidecarUpdateManagerOptions;

  constructor(options: SidecarUpdateManagerOptions) {
    validateRelease(options.embeddedRelease, "embeddedRelease");
    if (
      !Number.isSafeInteger(options.homeCompatEpoch) ||
      options.homeCompatEpoch < 1 ||
      !SHA256_PATTERN.test(options.expectedAcpFixtureSha256) ||
      options.acceptedPatchSha256.length === 0 ||
      !options.acceptedPatchSha256.every((hash) => SHA256_PATTERN.test(hash))
    ) {
      throw new Error("Updater compatibility options are invalid.");
    }
    if (!options.acceptedPatchSha256.includes(options.embeddedRelease.patchSha256)) {
      // The embedded patch is part of the app's trusted compatibility set.
      throw new Error("acceptedPatchSha256 must include the embedded release patch hash.");
    }
    if (
      options.embeddedRelease.homeCompatEpoch !== options.homeCompatEpoch ||
      options.embeddedRelease.target !== options.target ||
      options.embeddedRelease.acpFixtureSha256 !== options.expectedAcpFixtureSha256
    ) {
      throw new Error("Embedded release metadata does not match the updater compatibility contract.");
    }
    this.#options = {
      ...options,
      embeddedRelease: { ...options.embeddedRelease },
      trustedKeys: [...options.trustedKeys],
      acceptedPatchSha256: [...options.acceptedPatchSha256],
    };
  }

  async apply(signedManifest: unknown, signal?: AbortSignal): Promise<SidecarUpdateResult> {
    return this.#options.installer.withUpdateLock(async () => {
      throwIfAborted(signal);
      const state = await this.#options.installer.readState(this.#options.embeddedRelease);
      const binaryName = this.#options.target.startsWith("win32-") ? "grok.exe" : "grok";
      await this.#options.installer.assertLayout(state, binaryName);
      if (
        state.homeCompatEpoch !== this.#options.homeCompatEpoch ||
        this.#options.embeddedRelease.homeCompatEpoch !== this.#options.homeCompatEpoch
      ) {
        throw new SidecarUpdateError("compatibility", "Installed and embedded homeCompatEpoch values disagree.");
      }

      let payload: SidecarManifestPayload;
      try {
        payload = verifySignedSidecarManifest(signedManifest, this.#options.trustedKeys, {
          expectedChannel: this.#options.channel,
          ...(this.#options.requiredSignatures === undefined
            ? {}
            : { requiredSignatures: this.#options.requiredSignatures }),
        }).payload;
      } catch (error) {
        throw new SidecarUpdateError("manifest", "Sidecar manifest verification failed.", error);
      }

      if (payload.sequence < state.highestSequence) {
        throw new SidecarUpdateError(
          "sequence",
          `Manifest sequence ${payload.sequence} is below anti-rollback floor ${state.highestSequence}.`,
        );
      }

      if (!isAppVersionCompatible(this.#options.appVersion, payload.appCompatibility)) {
        throw new SidecarUpdateError("compatibility", "The sidecar is incompatible with this app version.");
      }
      if (payload.homeCompatEpoch !== this.#options.homeCompatEpoch) {
        throw new SidecarUpdateError("compatibility", "The sidecar uses a different homeCompatEpoch.");
      }
      if (payload.acp.fixtureSha256 !== this.#options.expectedAcpFixtureSha256) {
        throw new SidecarUpdateError("compatibility", "The sidecar ACP fixture hash is not accepted by this app.");
      }
      if (!this.#options.acceptedPatchSha256.includes(payload.patchSha256)) {
        throw new SidecarUpdateError("compatibility", "The sidecar patch hash is not accepted by this app.");
      }

      const artifact = payload.artifacts[this.#options.target];
      if (!artifact) {
        throw new SidecarUpdateError("platform", `Manifest has no artifact for ${this.#options.target}.`);
      }

      const current = state.active ?? this.#options.embeddedRelease;
      if (payload.sequence === state.highestSequence) {
        if (currentMatches(current, payload, artifact, this.#options.target)) {
          return { status: "up-to-date", release: current };
        }
        throw new SidecarUpdateError("sequence", "Manifest sequence was reused for different release content.");
      }

      const stagePath = await this.#options.installer.createStage();
      let preserveStage = false;
      try {
        const artifactPath = join(stagePath, "artifact.download");
        try {
          await this.#options.downloader.download({
            url: artifact.url,
            destinationPath: artifactPath,
            expectedSize: artifact.size,
            expectedSha256: artifact.sha256,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          throw new SidecarUpdateError("download", "Sidecar artifact download failed.", error);
        }
        throwIfAborted(signal);

        const downloadedInfo = await lstat(artifactPath).catch((error) => {
          throw new SidecarUpdateError("integrity", "Downloader did not produce an artifact file.", error);
        });
        if (!downloadedInfo.isFile() || downloadedInfo.isSymbolicLink()) {
          throw new SidecarUpdateError("integrity", "Downloaded artifact must be a regular file.");
        }
        if (downloadedInfo.size !== artifact.size) {
          throw new SidecarUpdateError(
            "integrity",
            `Downloaded artifact size ${downloadedInfo.size} does not match ${artifact.size}.`,
          );
        }
        if ((await sha256File(artifactPath)) !== artifact.sha256) {
          throw new SidecarUpdateError("integrity", "Downloaded artifact SHA-256 does not match the manifest.");
        }

        const candidateDirectory = join(stagePath, "candidate");
        await mkdir(candidateDirectory, { mode: 0o700 });
        try {
          await this.#options.artifactStager.stage({
            artifactPath,
            destinationDirectory: candidateDirectory,
            binaryName,
            target: this.#options.target,
            manifest: payload,
          });
        } catch (error) {
          throw new SidecarUpdateError("staging", "Sidecar artifact could not be staged.", error);
        }
        const binaryPath = await this.#options.installer.assertStagedBinary(candidateDirectory, binaryName);

        try {
          await this.#options.platformSignatureVerifier({
            binaryPath,
            target: this.#options.target,
            artifact,
            manifest: payload,
          });
        } catch (error) {
          throw new SidecarUpdateError("platform-signature", "Platform signature verification failed.", error);
        }

        let reportedVersion: string;
        try {
          reportedVersion = await this.#options.versionSmoke({
            binaryPath,
            args: ["--version"],
            expectedVersion: payload.version,
          });
        } catch (error) {
          throw new SidecarUpdateError("version-smoke", "The --version smoke check failed.", error);
        }
        if (reportedVersion !== payload.version) {
          throw new SidecarUpdateError(
            "version-smoke",
            `Staged sidecar reported ${reportedVersion}; expected ${payload.version}.`,
          );
        }

        const smokeWorkspaceRoot = resolve(this.#options.smokeWorkspaceRoot);
        try {
          await this.#options.acpInitializeSmoke({
            binaryPath,
            args: payload.acp.command.map((argument) =>
              argument === "<root>" ? smokeWorkspaceRoot : argument,
            ),
            workspaceRoot: smokeWorkspaceRoot,
            fixtureSha256: payload.acp.fixtureSha256,
          });
        } catch (error) {
          throw new SidecarUpdateError("acp-smoke", "ACP initialize smoke check failed.", error);
        }

        const release: InstalledSidecarRelease = {
          version: payload.version,
          sequence: payload.sequence,
          channel: payload.channel,
          target: this.#options.target,
          artifactSha256: artifact.sha256,
          artifactSize: artifact.size,
          sidecarLockSha256: payload.sidecarLockSha256,
          patchSha256: payload.patchSha256,
          acpFixtureSha256: payload.acp.fixtureSha256,
          homeCompatEpoch: payload.homeCompatEpoch,
          installedAt: (this.#options.now?.() ?? new Date()).toISOString(),
        };
        await this.#options.installer.writeReleaseMetadata(candidateDirectory, release);
        const nextState: SidecarUpdateState = {
          schemaVersion: 1,
          highestSequence: payload.sequence,
          homeCompatEpoch: payload.homeCompatEpoch,
          active: release,
          ...(state.active ? { previous: state.active } : {}),
        };
        try {
          await this.#options.installer.activate(stagePath, candidateDirectory, state, nextState);
        } catch (error) {
          if (error instanceof SidecarActivationError && !error.rollbackComplete) preserveStage = true;
          throw error;
        }
        return {
          status: "installed",
          release,
          ...(state.active ? { previous: state.active } : {}),
        };
      } finally {
        if (!preserveStage) await this.#options.installer.discardStage(stagePath).catch(() => undefined);
      }
    });
  }
}
