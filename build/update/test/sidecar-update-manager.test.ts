import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalizeJcsBytes } from "../jcs.js";
import { sha256Hex, type SidecarManifestPayload } from "../manifest.js";
import {
  SidecarInstaller,
  SidecarUpdateError,
  SidecarUpdateManager,
  type AcpInitializeSmokeRequest,
  type ActivationPhase,
  type InstalledSidecarRelease,
  type PlatformSignatureRequest,
  type StagingDownloadRequest,
  type VersionSmokeRequest,
} from "../sidecar-update-manager.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TARGET = "darwin-arm64";
const FIXTURE_HASH = "d".repeat(64);
const PATCH_HASH = "c".repeat(64);
const EMBEDDED_PATCH_HASH = "e".repeat(64);
const LOCK_HASH = "a".repeat(64);
const NEW_BINARY = Buffer.from("new signed grok sidecar");
const OLD_BINARY = Buffer.from("old active sidecar");
const OLDER_BINARY = Buffer.from("older previous sidecar");
const EMBEDDED_BINARY = Buffer.from("embedded fallback sidecar");

function release(overrides: Partial<InstalledSidecarRelease>): InstalledSidecarRelease {
  return {
    version: "0.2.101",
    sequence: 6,
    channel: "stable",
    target: TARGET,
    artifactSha256: sha256Hex(OLD_BINARY),
    artifactSize: OLD_BINARY.length,
    sidecarLockSha256: LOCK_HASH,
    patchSha256: PATCH_HASH,
    acpFixtureSha256: FIXTURE_HASH,
    homeCompatEpoch: 1,
    installedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function payload(): SidecarManifestPayload {
  return {
    schemaVersion: 1,
    product: "xora-grok-sidecar",
    sequence: 7,
    channel: "stable",
    version: "0.2.102",
    releasedAt: "2026-07-19T00:00:00.000Z",
    homeCompatEpoch: 1,
    patchSha256: PATCH_HASH,
    appCompatibility: { minimumVersion: "0.1.0", maximumVersion: "0.2.0" },
    sidecarLockSha256: LOCK_HASH,
    upstream: {
      commit: "98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce",
      sourceRevision: "124d85bc5dc6e7805560215fcc6d5413944920e1",
    },
    acp: {
      transport: "stdio",
      command: ["--no-auto-update", "--cwd", "<root>", "agent", "--no-leader", "stdio"],
      fixtureSha256: FIXTURE_HASH,
    },
    artifacts: {
      [TARGET]: {
        url: "https://updates.example.com/grok/0.2.102/darwin-arm64.tar.zst",
        sha256: sha256Hex(NEW_BINARY),
        size: NEW_BINARY.length,
      },
    },
  };
}

interface FixtureOptions {
  downloadedBytes?: Buffer;
  platformError?: Error;
  reportedVersion?: string;
  acpError?: Error;
  activationFailurePhase?: ActivationPhase;
}

interface Fixture {
  root: string;
  smokeRoot: string;
  manager: SidecarUpdateManager;
  installer: SidecarInstaller;
  manifestPayload: SidecarManifestPayload;
  privateKey: KeyObject;
  calls: string[];
  downloadRequests: StagingDownloadRequest[];
  platformRequests: PlatformSignatureRequest[];
  versionRequests: VersionSmokeRequest[];
  acpRequests: AcpInitializeSmokeRequest[];
  activeRelease: InstalledSidecarRelease;
  previousRelease: InstalledSidecarRelease;
  embeddedRelease: InstalledSidecarRelease;
}

function signed(payloadValue: SidecarManifestPayload, privateKey: KeyObject) {
  return {
    payload: payloadValue,
    signatures: [
      {
        keyId: "release-key",
        algorithm: "ed25519" as const,
        signature: sign(null, canonicalizeJcsBytes(payloadValue), privateKey).toString("base64"),
      },
    ],
  };
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "whitenight-update-test-"));
  roots.push(root);
  const smokeRoot = join(root, "smoke-workspace");
  await mkdir(smokeRoot);

  const embeddedRelease = release({
    version: "0.2.99",
    sequence: 4,
    artifactSha256: sha256Hex(EMBEDDED_BINARY),
    artifactSize: EMBEDDED_BINARY.length,
    patchSha256: EMBEDDED_PATCH_HASH,
    installedAt: "2026-07-16T00:00:00.000Z",
  });
  const previousRelease = release({
    version: "0.2.100",
    sequence: 5,
    artifactSha256: sha256Hex(OLDER_BINARY),
    artifactSize: OLDER_BINARY.length,
    installedAt: "2026-07-17T00:00:00.000Z",
  });
  const activeRelease = release({});

  for (const [directory, bytes] of [
    ["embedded", EMBEDDED_BINARY],
    ["active", OLD_BINARY],
    ["previous", OLDER_BINARY],
  ] as const) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, "grok"), bytes, { mode: 0o755 });
  }
  await writeFile(
    join(root, "update-state.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      highestSequence: activeRelease.sequence,
      homeCompatEpoch: 1,
      active: activeRelease,
      previous: previousRelease,
    })}\n`,
    { mode: 0o600 },
  );

  const calls: string[] = [];
  const downloadRequests: StagingDownloadRequest[] = [];
  const platformRequests: PlatformSignatureRequest[] = [];
  const versionRequests: VersionSmokeRequest[] = [];
  const acpRequests: AcpInitializeSmokeRequest[] = [];
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const installer = new SidecarInstaller(root, {
    ...(options.activationFailurePhase
      ? {
          activationHook: (phase) => {
            if (phase === options.activationFailurePhase) throw new Error(`activation failed at ${phase}`);
          },
        }
      : {}),
  });
  const manager = new SidecarUpdateManager({
    installer,
    downloader: {
      async download(request) {
        calls.push("download");
        downloadRequests.push(request);
        await writeFile(request.destinationPath, options.downloadedBytes ?? NEW_BINARY);
      },
    },
    artifactStager: {
      async stage(request) {
        calls.push("stage");
        await copyFile(request.artifactPath, join(request.destinationDirectory, request.binaryName));
      },
    },
    async platformSignatureVerifier(request) {
      calls.push("platform-signature");
      platformRequests.push(request);
      if (options.platformError) throw options.platformError;
    },
    async versionSmoke(request) {
      calls.push("version-smoke");
      versionRequests.push(request);
      return options.reportedVersion ?? "0.2.102";
    },
    async acpInitializeSmoke(request) {
      calls.push("acp-smoke");
      acpRequests.push(request);
      if (options.acpError) throw options.acpError;
    },
    trustedKeys: [
      {
        keyId: "release-key",
        algorithm: "ed25519",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
    embeddedRelease,
    appVersion: "0.1.0",
    channel: "stable",
    target: TARGET,
    homeCompatEpoch: 1,
    expectedAcpFixtureSha256: FIXTURE_HASH,
    acceptedPatchSha256: [EMBEDDED_PATCH_HASH, PATCH_HASH],
    smokeWorkspaceRoot: smokeRoot,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
  });
  return {
    root,
    smokeRoot,
    manager,
    installer,
    manifestPayload: payload(),
    privateKey,
    calls,
    downloadRequests,
    platformRequests,
    versionRequests,
    acpRequests,
    activeRelease,
    previousRelease,
    embeddedRelease,
  };
}

async function assertOriginalInstall(fixture: Fixture): Promise<void> {
  assert.deepEqual(await readFile(join(fixture.root, "active", "grok")), OLD_BINARY);
  assert.deepEqual(await readFile(join(fixture.root, "previous", "grok")), OLDER_BINARY);
  assert.deepEqual(await readFile(join(fixture.root, "embedded", "grok")), EMBEDDED_BINARY);
  const state = await fixture.installer.readState(fixture.embeddedRelease);
  assert.equal(state.highestSequence, 6);
  assert.equal(state.active?.version, "0.2.101");
  assert.equal(state.previous?.version, "0.2.100");
}

describe("SidecarUpdateManager", () => {
  it("validates, smokes, atomically activates, and retains embedded plus previous", async () => {
    const fixture = await createFixture();
    const result = await fixture.manager.apply(signed(fixture.manifestPayload, fixture.privateKey));

    assert.equal(result.status, "installed");
    assert.deepEqual(fixture.calls, [
      "download",
      "stage",
      "platform-signature",
      "version-smoke",
      "acp-smoke",
    ]);
    assert.deepEqual(await readFile(join(fixture.root, "active", "grok")), NEW_BINARY);
    assert.deepEqual(await readFile(join(fixture.root, "previous", "grok")), OLD_BINARY);
    assert.deepEqual(await readFile(join(fixture.root, "embedded", "grok")), EMBEDDED_BINARY);

    const state = await fixture.installer.readState(fixture.embeddedRelease);
    assert.equal(state.highestSequence, 7);
    assert.equal(state.active?.version, "0.2.102");
    assert.equal(state.active?.installedAt, "2026-07-19T12:00:00.000Z");
    assert.equal(state.previous?.version, "0.2.101");
    assert.deepEqual(fixture.versionRequests[0]?.args, ["--version"]);
    assert.equal(fixture.platformRequests[0]?.target, TARGET);
    assert.equal(fixture.acpRequests[0]?.fixtureSha256, FIXTURE_HASH);
    assert.deepEqual(fixture.acpRequests[0]?.args, [
      "--no-auto-update",
      "--cwd",
      resolve(fixture.smokeRoot),
      "agent",
      "--no-leader",
      "stdio",
    ]);
    assert.equal(fixture.downloadRequests[0]?.expectedSize, NEW_BINARY.length);
    assert.equal(fixture.downloadRequests[0]?.expectedSha256, sha256Hex(NEW_BINARY));
    assert.deepEqual(await readdir(join(fixture.root, ".staging")), []);
  });

  it("rejects rollback, app, epoch, fixture, patch, and platform mismatches before download", async () => {
    const scenarios: Array<{
      name: string;
      code: string;
      mutate(value: SidecarManifestPayload): void;
    }> = [
      { name: "rollback", code: "sequence", mutate: (value) => void (value.sequence = 5) },
      {
        name: "app",
        code: "compatibility",
        mutate: (value) => void (value.appCompatibility.minimumVersion = "0.1.1"),
      },
      { name: "epoch", code: "compatibility", mutate: (value) => void (value.homeCompatEpoch = 2) },
      {
        name: "fixture",
        code: "compatibility",
        mutate: (value) => void (value.acp.fixtureSha256 = "f".repeat(64)),
      },
      { name: "patch", code: "compatibility", mutate: (value) => void (value.patchSha256 = "f".repeat(64)) },
      {
        name: "platform",
        code: "platform",
        mutate: (value) => {
          value.artifacts["linux-x64"] = value.artifacts[TARGET]!;
          delete value.artifacts[TARGET];
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = await createFixture();
      scenario.mutate(fixture.manifestPayload);
      await assert.rejects(
        fixture.manager.apply(signed(fixture.manifestPayload, fixture.privateKey)),
        (error: unknown) =>
          error instanceof SidecarUpdateError &&
          error.code === scenario.code &&
          Boolean(scenario.name),
      );
      assert.equal(fixture.calls.includes("download"), false);
      await assertOriginalInstall(fixture);
    }
  });

  it("does not download an identical manifest sequence twice", async () => {
    const fixture = await createFixture();
    const artifact = fixture.manifestPayload.artifacts[TARGET]!;
    fixture.manifestPayload.sequence = fixture.activeRelease.sequence;
    fixture.manifestPayload.version = fixture.activeRelease.version;
    fixture.manifestPayload.patchSha256 = fixture.activeRelease.patchSha256;
    fixture.manifestPayload.sidecarLockSha256 = fixture.activeRelease.sidecarLockSha256;
    artifact.sha256 = fixture.activeRelease.artifactSha256;
    artifact.size = fixture.activeRelease.artifactSize;

    const result = await fixture.manager.apply(signed(fixture.manifestPayload, fixture.privateKey));
    assert.equal(result.status, "up-to-date");
    assert.deepEqual(fixture.calls, []);
    await assertOriginalInstall(fixture);
  });

  it("rejects size and same-size hash mismatches without staging or smoke checks", async () => {
    for (const downloadedBytes of [
      Buffer.from("short"),
      Buffer.alloc(NEW_BINARY.length, 0x78),
    ]) {
      const fixture = await createFixture({ downloadedBytes });
      await assert.rejects(
        fixture.manager.apply(signed(fixture.manifestPayload, fixture.privateKey)),
        (error: unknown) => error instanceof SidecarUpdateError && error.code === "integrity",
      );
      assert.deepEqual(fixture.calls, ["download"]);
      await assertOriginalInstall(fixture);
    }
  });

  it("keeps the active install on platform, version, and ACP smoke failures", async () => {
    for (const [options, expectedCode] of [
      [{ platformError: new Error("unsigned") }, "platform-signature"],
      [{ reportedVersion: "0.2.999" }, "version-smoke"],
      [{ acpError: new Error("initialize failed") }, "acp-smoke"],
    ] as const) {
      const fixture = await createFixture(options);
      await assert.rejects(
        fixture.manager.apply(signed(fixture.manifestPayload, fixture.privateKey)),
        (error: unknown) => error instanceof SidecarUpdateError && error.code === expectedCode,
      );
      await assertOriginalInstall(fixture);
      assert.deepEqual(await readdir(join(fixture.root, ".staging")), []);
    }
  });

  it("rolls directory rotation back when atomic activation fails", async () => {
    const fixture = await createFixture({ activationFailurePhase: "after-promote-candidate" });
    await assert.rejects(
      fixture.manager.apply(signed(fixture.manifestPayload, fixture.privateKey)),
      (error: unknown) => error instanceof SidecarUpdateError && error.code === "activation",
    );
    await assertOriginalInstall(fixture);
    assert.deepEqual(await readdir(join(fixture.root, ".staging")), []);
  });

  it("explicitly rolls back to previous without lowering the anti-rollback floor", async () => {
    const fixture = await createFixture();
    const release = await fixture.installer.rollbackToPrevious(fixture.embeddedRelease);
    assert.equal(release.version, "0.2.100");
    assert.deepEqual(await readFile(join(fixture.root, "active", "grok")), OLDER_BINARY);
    assert.deepEqual(await readFile(join(fixture.root, "previous", "grok")), OLD_BINARY);
    assert.deepEqual(await readFile(join(fixture.root, "embedded", "grok")), EMBEDDED_BINARY);
    const state = await fixture.installer.readState(fixture.embeddedRelease);
    assert.equal(state.highestSequence, 6);
    assert.equal(state.active?.version, "0.2.100");
    assert.equal(state.previous?.version, "0.2.101");
    assert.deepEqual(await readdir(join(fixture.root, ".staging")), []);
  });

  it("restores the immutable embedded baseline when the first update has no previous release", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.root, "previous"), { recursive: true, force: true });
    await writeFile(
      join(fixture.root, "update-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        highestSequence: fixture.activeRelease.sequence,
        homeCompatEpoch: 1,
        active: fixture.activeRelease,
      })}\n`,
      { mode: 0o600 },
    );

    const restored = await fixture.installer.rollbackToPrevious(fixture.embeddedRelease);
    assert.equal(restored.version, fixture.embeddedRelease.version);
    await assert.rejects(readFile(join(fixture.root, "active", "grok")), /ENOENT/u);
    assert.deepEqual(await readFile(join(fixture.root, "previous", "grok")), OLD_BINARY);
    assert.deepEqual(await readFile(join(fixture.root, "embedded", "grok")), EMBEDDED_BINARY);
    const state = await fixture.installer.readState(fixture.embeddedRelease);
    assert.equal(state.highestSequence, fixture.activeRelease.sequence);
    assert.equal(state.active, undefined);
    assert.equal(state.previous?.version, fixture.activeRelease.version);
    assert.deepEqual(await readdir(join(fixture.root, ".staging")), []);
  });
});
