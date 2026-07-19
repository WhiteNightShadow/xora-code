import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalizeJcsBytes } from "../jcs.js";
import {
  compareSemver,
  isAppVersionCompatible,
  sha256Hex,
  verifySha256,
  verifySignedSidecarManifest,
  type SidecarManifestPayload,
} from "../manifest.js";

function payload(): SidecarManifestPayload {
  return {
    schemaVersion: 1,
    product: "whitenight-grok-sidecar",
    sequence: 7,
    channel: "stable",
    version: "0.2.102",
    releasedAt: "2026-07-19T00:00:00.000Z",
    homeCompatEpoch: 1,
    patchSha256: "c".repeat(64),
    appCompatibility: { minimumVersion: "0.1.0", maximumVersion: "0.2.0" },
    sidecarLockSha256: "a".repeat(64),
    upstream: {
      commit: "98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce",
      sourceRevision: "124d85bc5dc6e7805560215fcc6d5413944920e1",
    },
    acp: {
      transport: "stdio",
      command: ["--no-auto-update", "--cwd", "<root>", "agent", "--no-leader", "stdio"],
      fixtureSha256: "d".repeat(64),
    },
    artifacts: {
      "darwin-arm64": {
        url: "https://updates.example.com/grok/0.2.102/darwin-arm64.tar.zst",
        sha256: "b".repeat(64),
        size: 12345,
      },
    },
  };
}

function signedManifest(manifestPayload = payload()) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, canonicalizeJcsBytes(manifestPayload), privateKey).toString("base64");
  return {
    manifest: {
      payload: manifestPayload,
      signatures: [{ keyId: "release-2026", algorithm: "ed25519" as const, signature }],
    },
    trusted: [
      {
        keyId: "release-2026",
        algorithm: "ed25519" as const,
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
}

describe("signed sidecar manifests", () => {
  it("uses SemVer precedence for app compatibility", () => {
    assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.11"), -1);
    assert.equal(compareSemver("1.0.0+one", "1.0.0+two"), 0);
    assert.equal(
      isAppVersionCompatible("0.1.5", { minimumVersion: "0.1.0", maximumVersion: "0.2.0" }),
      true,
    );
    assert.equal(
      isAppVersionCompatible("0.2.1", { minimumVersion: "0.1.0", maximumVersion: "0.2.0" }),
      false,
    );
    assert.throws(
      () => isAppVersionCompatible("1.0.0-01", { minimumVersion: "1.0.0" }),
      /leading zeroes/,
    );
  });

  it("verifies Ed25519 signatures over JCS payloads", () => {
    const fixture = signedManifest();
    const result = verifySignedSidecarManifest(fixture.manifest, fixture.trusted, {
      expectedChannel: "stable",
      minimumSequence: 7,
    });
    assert.deepEqual(result.validKeyIds, ["release-2026"]);
    assert.equal(result.payload.version, "0.2.102");
  });

  it("rejects tampering, rollback, and revoked keys", () => {
    const fixture = signedManifest();
    fixture.manifest.payload.version = "0.2.103";
    assert.throws(() => verifySignedSidecarManifest(fixture.manifest, fixture.trusted), /valid signature/);

    const rollback = signedManifest();
    assert.throws(
      () => verifySignedSidecarManifest(rollback.manifest, rollback.trusted, { minimumSequence: 8 }),
      /anti-rollback/,
    );
    assert.throws(
      () =>
        verifySignedSidecarManifest(rollback.manifest, [
          { ...rollback.trusted[0]!, revoked: true },
        ]),
      /valid signature/,
    );
  });

  it("accepts raw public keys and verifies artifact digests", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifestPayload = payload();
    const signature = sign(null, canonicalizeJcsBytes(manifestPayload), privateKey).toString("base64");
    const der = publicKey.export({ type: "spki", format: "der" });
    const manifest = {
      payload: manifestPayload,
      signatures: [{ keyId: "raw-key", algorithm: "ed25519" as const, signature }],
    };
    assert.equal(
      verifySignedSidecarManifest(manifest, [
        { keyId: "raw-key", algorithm: "ed25519", publicKey: der.subarray(-32) },
      ]).validKeyIds[0],
      "raw-key",
    );
    const data = Buffer.from("artifact bytes");
    assert.equal(verifySha256(data, sha256Hex(data)), true);
    assert.equal(verifySha256(Buffer.from("tampered"), sha256Hex(data)), false);
  });
});
