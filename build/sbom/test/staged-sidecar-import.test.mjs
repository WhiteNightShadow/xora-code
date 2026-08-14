// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const importer = fileURLToPath(new URL("../../release/import-staged-sidecar.py", import.meta.url));
const python = findPython();
const notices = [
  "GROK-BUILD-COMPATIBILITY-PATCHES.md",
  "GROK-BUILD-LICENSE",
  "GROK-BUILD-THIRD-PARTY-NOTICES",
  "GROK-TOOLS-THIRD-PARTY-NOTICES.md",
  "GROK-VENDORED-NOTICE",
  "RIPGREP-SOURCE-BUILD-NOTICE.md",
  "THIRD-PARTY-NOTICES.md",
  "XAI-RATATUI-INLINE-NOTICE",
  "XAI-RATATUI-TEXTAREA-NOTICE",
  "XORA-CODE-LICENSE",
  "XORA-CODE-NOTICE.md",
];

function findPython() {
  for (const candidate of process.platform === "win32" ? ["python.exe", "py.exe"] : ["python3", "python"]) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  return undefined;
}

function makeFixture(root, target = "linux-x64") {
  const source = path.join(root, "verified-stage");
  const destination = path.join(root, "fresh-source", "resources", "sidecars", "grok");
  fs.mkdirSync(path.join(source, "notices"), { recursive: true });
  fs.mkdirSync(path.join(source, "packaging-tools"), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  const suffix = target === "win32-x64" ? ".exe" : "";
  const binary = `grok${suffix}`;
  const ripgrep = `rg${suffix}`;
  const files = [
    "README.md", "release.json", binary, `${binary}.sha256`,
    `packaging-tools/${ripgrep}`, `packaging-tools/${ripgrep}.sha256`,
    ...notices.map(name => `notices/${name}`),
  ];
  for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), `fixture:${relative}\n`);
  }
  fs.writeFileSync(path.join(destination, "README.md"), "fixture:README.md\n");
  return { source, destination, files, target };
}

function run(fixture) {
  return spawnSync(python, [
    importer,
    "--source", fixture.source,
    "--destination", fixture.destination,
    "--target", fixture.target,
  ], { encoding: "utf8" });
}

for (const target of ["linux-x64", "win32-x64"]) {
  test(`staged sidecar importer copies only the exact ${target} release structure`, { skip: !python }, context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `xora-staged-sidecar-${target}-`));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = makeFixture(root, target);
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    for (const relative of fixture.files) {
      assert.equal(fs.readFileSync(path.join(fixture.destination, relative), "utf8"), `fixture:${relative}\n`);
    }
  });
}

test("staged sidecar importer rejects extra files before changing the destination", { skip: !python }, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-staged-sidecar-extra-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = makeFixture(root);
  fs.writeFileSync(path.join(fixture.source, "unexpected.txt"), "unexpected\n");
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source file structure mismatch/u);
  assert.deepEqual(fs.readdirSync(fixture.destination), ["README.md"]);
});

test("staged sidecar importer rejects links before changing the destination", { skip: !python }, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-staged-sidecar-link-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = makeFixture(root);
  const binary = path.join(fixture.source, "grok");
  fs.rmSync(binary);
  try {
    fs.symlinkSync(path.join(fixture.source, "release.json"), binary);
  } catch (error) {
    if (error?.code === "EPERM") {
      context.skip("this Windows host does not grant symbolic-link privileges");
      return;
    }
    throw error;
  }
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /link or special file/u);
  assert.deepEqual(fs.readdirSync(fixture.destination), ["README.md"]);
});

test("staged sidecar importer rejects hard-linked files before changing the destination", { skip: !python }, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-staged-sidecar-hardlink-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = makeFixture(root);
  const binary = path.join(fixture.source, "grok");
  fs.rmSync(binary);
  fs.linkSync(path.join(fixture.source, "release.json"), binary);
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hard-linked file/u);
  assert.deepEqual(fs.readdirSync(fixture.destination), ["README.md"]);
});

test("staged sidecar importer refuses to overwrite a non-fresh destination", { skip: !python }, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-staged-sidecar-destination-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = makeFixture(root);
  fs.writeFileSync(path.join(fixture.destination, "release.json"), "old\n");
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /destination is not a fresh source sidecar directory/u);
  assert.equal(fs.readFileSync(path.join(fixture.destination, "release.json"), "utf8"), "old\n");
});
