// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(directory, "../../..");
const require = createRequire(import.meta.url);
const { assertReleaseIdentity, targetForRuntime } = require(
  join(repositoryRoot, "applications/electron/scripts/verify-sidecar.js"),
);
const lock = JSON.parse(await readFile(join(repositoryRoot, "build/grok/sidecar.lock.json"), "utf8"));

function releaseFor(targetName) {
  return {
    schemaVersion: 1,
    target: targetName,
    rustTarget: lock.targets[targetName].rustTarget,
    cargoPackage: lock.toolchain.cargoPackage,
    cargoProfile: lock.toolchain.cargoProfile,
    sourcePatches: lock.sourcePatches
      .filter(patch => patch.targets.includes(targetName))
      .map(({ id, sha256 }) => ({ id, sha256 })),
    bundledTools: {
      ripgrep: {
        package: lock.bundledTools.ripgrep.package,
        version: lock.bundledTools.ripgrep.version,
        source: lock.bundledTools.ripgrep.source,
        features: lock.bundledTools.ripgrep.features,
        lockedSourceBuild: true,
      },
    },
  };
}

test("formal packaging maps every supported native runtime to one exact sidecar target", () => {
  assert.equal(targetForRuntime("darwin", "arm64"), "darwin-arm64");
  assert.equal(targetForRuntime("darwin", "x64"), "darwin-x64");
  assert.equal(targetForRuntime("win32", "x64"), "win32-x64");
  assert.equal(targetForRuntime("linux", "x64"), "linux-x64");
  assert.throws(() => targetForRuntime("linux", "arm64"), /not configured/u);
});

test("formal verifier accepts only release metadata for the current locked build identity", () => {
  const expectedTarget = "darwin-arm64";
  const release = releaseFor(expectedTarget);
  assert.doesNotThrow(() => assertReleaseIdentity(release, lock, expectedTarget));

  for (const [field, value] of [
    ["schemaVersion", 2],
    ["target", "darwin-x64"],
    ["rustTarget", lock.targets["darwin-x64"].rustTarget],
    ["cargoPackage", "unexpected-package"],
    ["cargoProfile", "release"],
    ["bundledTools", { ripgrep: { package: "ripgrep", version: "14.1.1", source: "crates.io", features: ["pcre2"], lockedSourceBuild: true } }],
  ]) {
    assert.throws(
      () => assertReleaseIdentity({ ...release, [field]: value }, lock, expectedTarget),
      /mismatch/u,
      `${field} must be fail-closed`,
    );
  }
});
