#!/usr/bin/env node
// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const lockPath = join(scriptDirectory, "sidecar.lock.json");

function fail(message) {
  throw new Error(`Sidecar release metadata refused: ${message}`);
}

function lockAndTarget(targetName) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const target = lock.targets[targetName];
  if (!target) fail(`unknown target ${targetName}`);
  return { lock, target };
}

function binaryAt(stageDirectory, lock, target) {
  const path = join(stageDirectory, `${lock.runtime.packagedBinaryName}${target.executableSuffix}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    fail(`binary must be a non-symlink regular file: ${path}`);
  }
  return { path, metadata };
}

function compute(stageDirectory, targetName) {
  const { lock, target } = lockAndTarget(targetName);
  const binary = binaryAt(stageDirectory, lock, target);
  const bytes = readFileSync(binary.path);
  const version = spawnSync(binary.path, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    shell: false,
  });
  if (version.status !== 0 || !`${version.stdout}\n${version.stderr}`.includes(lock.upstream.version)) {
    fail(`binary did not report Grok Build ${lock.upstream.version}`);
  }
  return {
    schemaVersion: 1,
    version: lock.upstream.version,
    upstreamCommit: lock.upstream.commit,
    sourceRevision: lock.upstream.sourceRevision,
    target: targetName,
    rustTarget: target.rustTarget,
    cargoPackage: lock.toolchain.cargoPackage,
    cargoProfile: lock.toolchain.cargoProfile,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: binary.metadata.size,
  };
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // Directory fsync is unavailable on Windows; the file itself is durable.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

export function writeSidecarReleaseMetadata(stageDirectory, targetName) {
  const absoluteStage = resolve(stageDirectory);
  const release = compute(absoluteStage, targetName);
  atomicWriteJson(join(absoluteStage, "release.json"), release);
  const { lock, target } = lockAndTarget(targetName);
  const name = `${lock.runtime.packagedBinaryName}${target.executableSuffix}`;
  writeFileSync(join(absoluteStage, `${name}.sha256`), `${release.sha256}  ${name}\n`, "utf8");
  return release;
}

export function verifySidecarReleaseMetadata(stageDirectory, targetName) {
  const absoluteStage = resolve(stageDirectory);
  const expected = compute(absoluteStage, targetName);
  const path = join(absoluteStage, "release.json");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("release.json must be a non-symlink regular file");
  const actual = JSON.parse(readFileSync(path, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("release.json does not exactly describe the current binary and pinned source");
  }
  return expected;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`--${name} is required`);
  return process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stageDirectory = argument("stage-dir");
  const targetName = argument("target");
  const verifyOnly = process.argv.includes("--verify");
  const release = verifyOnly
    ? verifySidecarReleaseMetadata(stageDirectory, targetName)
    : writeSidecarReleaseMetadata(stageDirectory, targetName);
  process.stdout.write(`${verifyOnly ? "Verified" : "Wrote"} release.json for ${targetName}: ${release.sha256}\n`);
}
