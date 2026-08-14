// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(new URL("../../release/extract-plugin-seed.py", import.meta.url));
const python = findPython();

function findPython() {
  for (const candidate of process.platform === "win32" ? ["python.exe", "py.exe"] : ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

function makeArchive(archive, kind) {
  const source = String.raw`
import io, sys, tarfile

archive_path, kind = sys.argv[1:]
with tarfile.open(archive_path, "w:gz") as archive:
    root = tarfile.TarInfo("plugins/")
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    archive.addfile(root)
    if kind == "valid":
        directory = tarfile.TarInfo("plugins/vscode.demo/")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o755
        archive.addfile(directory)
        payload = b'{"name":"vscode.demo"}\n'
        entry = tarfile.TarInfo("plugins/vscode.demo/package.json")
        entry.size = len(payload)
        entry.mode = 0o644
        archive.addfile(entry, io.BytesIO(payload))
    elif kind == "traversal":
        payload = b"escape\n"
        entry = tarfile.TarInfo("plugins/../escape.txt")
        entry.size = len(payload)
        archive.addfile(entry, io.BytesIO(payload))
    elif kind == "symlink":
        entry = tarfile.TarInfo("plugins/vscode.demo/link")
        entry.type = tarfile.SYMTYPE
        entry.linkname = "/tmp/escape"
        archive.addfile(entry)
    elif kind == "source-map":
        payload = b'{"sources":[]}'
        entry = tarfile.TarInfo("plugins/vscode.demo/dist/extension.js.map")
        entry.size = len(payload)
        archive.addfile(entry, io.BytesIO(payload))
    elif kind == "outside":
        payload = b"outside\n"
        entry = tarfile.TarInfo("other/file.txt")
        entry.size = len(payload)
        archive.addfile(entry, io.BytesIO(payload))
    elif kind == "case-collision":
        for name in ("plugins/Vscode.Demo/one.txt", "plugins/vscode.demo/two.txt"):
            payload = b"collision\n"
            entry = tarfile.TarInfo(name)
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))
`;
  const result = spawnSync(python, ["-c", source, archive, kind], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runExtractor(root, kind, overrideHash) {
  const archive = path.join(root, `${kind}.tar.gz`);
  const destination = path.join(root, "source", "plugins");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, ".gitkeep"), "");
  makeArchive(archive, kind);
  return {
    destination,
    result: spawnSync(
      python,
      [extractor, "--archive", archive, "--sha256", overrideHash ?? sha256(archive), "--destination", destination],
      { encoding: "utf8" },
    ),
  };
}

test("plugin seed extractor verifies and extracts regular files only below plugins", { skip: !python }, (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-plugin-seed-valid-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { destination, result } = runExtractor(root, "valid");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin-seed: verified sha256=[0-9a-f]{64} files=1/u);
  assert.equal(
    fs.readFileSync(path.join(destination, "vscode.demo", "package.json"), "utf8"),
    '{"name":"vscode.demo"}\n',
  );
  assert.equal(fs.existsSync(path.join(destination, ".gitkeep")), false);
});

for (const [kind, message] of [
  ["traversal", /dot path segment|outside plugins/u],
  ["symlink", /link or special file/u],
  ["source-map", /source map/u],
  ["outside", /outside plugins/u],
  ["case-collision", /case-colliding path/u],
]) {
  test(`plugin seed extractor rejects ${kind}`, { skip: !python }, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `xora-plugin-seed-${kind}-`));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { destination, result } = runExtractor(root, kind);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(fs.readdirSync(destination), [".gitkeep"]);
    assert.equal(fs.existsSync(path.join(root, "source", "escape.txt")), false);
  });
}

test("plugin seed extractor rejects a mismatched digest before changing plugins", { skip: !python }, (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-plugin-seed-hash-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { destination, result } = runExtractor(root, "valid", "0".repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch/u);
  assert.deepEqual(fs.readdirSync(destination), [".gitkeep"]);
});
