import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadGrokSidecarLock, validateGrokSidecarLock } from "../sidecar-lock.ts";

describe("Grok sidecar lock", () => {
  it("pins the audited Grok 0.2.102 source and toolchain", async () => {
    const lock = await loadGrokSidecarLock(new URL("../sidecar.lock.json", import.meta.url));
    assert.equal(lock.upstream.commit, "98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce");
    assert.equal(lock.upstream.sourceRevision, "124d85bc5dc6e7805560215fcc6d5413944920e1");
    assert.equal(lock.upstream.version, "0.2.102");
    assert.equal(lock.toolchain.rust, "1.92.0");
    assert.equal(lock.toolchain.dotslash, "0.5.7");
    assert.equal(lock.toolchain.protoc, "29.3");
    assert.equal(lock.toolchain.cargoPackage, "xai-grok-pager-bin");
    assert.equal(lock.runtime.packagedBinaryName, "grok");
    assert.deepEqual(lock.runtime.args, [
      "--no-auto-update",
      "--cwd",
      "<root>",
      "agent",
      "--no-leader",
      "stdio",
    ]);
  });

  it("rejects abbreviated revisions and sidecar self-update", () => {
    const base = {
      schemaVersion: 1,
      upstream: {
        repository: "https://github.com/xai-org/grok-build",
        commit: "98c3",
        sourceRevision: "124d85bc5dc6e7805560215fcc6d5413944920e1",
        version: "0.2.102",
        license: "Apache-2.0",
      },
      toolchain: {
        rust: "1.92.0",
        dotslash: "0.5.7",
        protoc: "29.3",
        cargoProfile: "release-dist",
        cargoPackage: "xai-grok-pager-bin",
        cargoBinary: "xai-grok-pager",
      },
      runtime: {
        packagedBinaryName: "grok",
        args: ["agent", "stdio"],
        transport: "stdio",
        protocol: "acp",
      },
      targets: { test: { rustTarget: "test-target", executableSuffix: "" } },
    };
    assert.throws(() => validateGrokSidecarLock(base), /full lowercase SHA-1/);
    base.upstream.commit = "98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce";
    assert.throws(() => validateGrokSidecarLock(base), /bind <root>/);
  });
});
