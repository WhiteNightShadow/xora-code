#!/usr/bin/env node
// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSidecarReleaseMetadata } from "./release-metadata.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const lockPath = join(scriptDirectory, "sidecar.lock.json");

function fail(message) {
  throw new Error(`Grok sidecar build refused: ${message}`);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(
        "Usage: node build/grok/build-sidecar.mjs --work-dir <dir> --target <lock target> [--stage-dir <dir>]\n",
      );
      process.exit(0);
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length) fail(`invalid argument ${argument}`);
    options[argument.slice(2)] = argv[++index];
  }
  if (!options["work-dir"]) fail("--work-dir is required");
  if (!options.target) fail("--target is required");
  return {
    workDirectory: resolve(options["work-dir"]),
    targetName: options.target,
    stageDirectory: resolve(options["stage-dir"] ?? join(repositoryRoot, "resources/sidecars/grok")),
  };
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: options.cwd,
    env: options.env,
  });
}

function captured(file, args, options = {}) {
  return run(file, args, { ...options, capture: true }).trim();
}

function assertExactSource(sourceDirectory, lock) {
  const head = captured("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory });
  if (head !== lock.upstream.commit) {
    fail(`checked-out commit is ${head}; expected ${lock.upstream.commit}`);
  }

  const sourceRevision = readFileSync(join(sourceDirectory, "SOURCE_REV"), "utf8").trim();
  if (sourceRevision !== lock.upstream.sourceRevision) {
    fail(`SOURCE_REV is ${sourceRevision}; expected ${lock.upstream.sourceRevision}`);
  }

  const toolchain = readFileSync(join(sourceDirectory, "rust-toolchain.toml"), "utf8");
  const channel = /^channel\s*=\s*"([^"]+)"/mu.exec(toolchain)?.[1];
  if (channel !== lock.toolchain.rust) {
    fail(`upstream rust-toolchain.toml pins ${channel ?? "nothing"}; expected ${lock.toolchain.rust}`);
  }
}

function checkoutExactSource(sourceDirectory, lock) {
  mkdirSync(sourceDirectory, { recursive: true });
  run("git", ["init", "--quiet"], { cwd: sourceDirectory });
  run("git", ["remote", "add", "origin", lock.upstream.repository], { cwd: sourceDirectory });
  run("git", ["fetch", "--depth=1", "origin", lock.upstream.commit], { cwd: sourceDirectory });
  run("git", ["checkout", "--detach", "--quiet", "FETCH_HEAD"], { cwd: sourceDirectory });
  assertExactSource(sourceDirectory, lock);
}

function assertNativeToolchain(lock, target) {
  const versionLine = captured("rustc", ["--version"]);
  const actualVersion = /^rustc\s+([^\s]+)/u.exec(versionLine)?.[1];
  if (actualVersion !== lock.toolchain.rust) {
    fail(`rustc is ${actualVersion ?? versionLine}; expected exactly ${lock.toolchain.rust}`);
  }

  const verboseVersion = captured("rustc", ["-vV"]);
  const host = /^host:\s*(\S+)$/mu.exec(verboseVersion)?.[1];
  if (host !== target.rustTarget) {
    fail(`runner host is ${host ?? "unknown"}; ${target.rustTarget} must be built on its native runner`);
  }

  try {
    const dotslashVersion = captured("dotslash", ["--version"]);
    if (!dotslashVersion.includes(lock.toolchain.dotslash)) {
      fail(`DotSlash reports ${JSON.stringify(dotslashVersion)}; expected ${lock.toolchain.dotslash}`);
    }
  } catch {
    fail(`DotSlash ${lock.toolchain.dotslash} is required by the pinned Grok Build source`);
  }
}

function main() {
  const { workDirectory, targetName, stageDirectory } = parseArguments(process.argv.slice(2));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const target = lock.targets[targetName];
  if (!target) fail(`target ${targetName} is not present in sidecar.lock.json`);

  const sourceDirectory = join(workDirectory, "source");
  const targetDirectory = join(workDirectory, "target");
  mkdirSync(workDirectory, { recursive: true });
  checkoutExactSource(sourceDirectory, lock);
  assertNativeToolchain(lock, target);

  const buildEnvironment = {
    ...process.env,
    CARGO_INCREMENTAL: "0",
    CARGO_TARGET_DIR: targetDirectory,
    SOURCE_DATE_EPOCH: "0",
  };
  if (process.platform === "win32") {
    const protoc = captured("where.exe", ["protoc.exe"]).split(/\r?\n/u)[0];
    const protocVersion = captured(protoc, ["--version"]);
    if (protocVersion !== `libprotoc ${lock.toolchain.protoc}`) {
      fail(`Windows protoc reports ${JSON.stringify(protocVersion)}; expected libprotoc ${lock.toolchain.protoc}`);
    }
    buildEnvironment.PROTOC = protoc;
  }
  // Keep this invocation aligned with the audited command in sidecar.lock.json.
  run(
    "cargo",
    ["build", "-p", lock.toolchain.cargoPackage, "--profile", lock.toolchain.cargoProfile],
    { cwd: sourceDirectory, env: buildEnvironment },
  );

  const sourceBinary = join(
    targetDirectory,
    lock.toolchain.cargoProfile,
    `${lock.toolchain.cargoBinary}${target.executableSuffix}`,
  );
  const sourceStat = statSync(sourceBinary);
  if (!sourceStat.isFile() || sourceStat.size === 0) fail(`Cargo did not produce ${sourceBinary}`);

  mkdirSync(stageDirectory, { recursive: true });
  const stagedName = `${lock.runtime.packagedBinaryName}${target.executableSuffix}`;
  const stagedBinary = join(stageDirectory, stagedName);
  copyFileSync(sourceBinary, stagedBinary);
  if (target.executableSuffix === "") chmodSync(stagedBinary, 0o755);

  const noticesDirectory = join(stageDirectory, "notices");
  mkdirSync(noticesDirectory, { recursive: true });
  const legalRoot = join(repositoryRoot, "resources/legal/grok-build");
  const auditedUpstreamNotices = [
    ["LICENSE", "LICENSE"],
    ["THIRD-PARTY-NOTICES", "THIRD-PARTY-NOTICES"],
    ["crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md", "crates/xai-grok-tools/THIRD_PARTY_NOTICES.md"],
    ["crates/codegen/xai-ratatui-inline/NOTICE", "crates/xai-ratatui-inline/NOTICE"],
    ["crates/codegen/xai-ratatui-textarea/NOTICE", "crates/xai-ratatui-textarea/NOTICE"],
    ["third_party/NOTICE", "third_party/NOTICE"],
  ];
  for (const [upstreamRelative, packagedRelative] of auditedUpstreamNotices) {
    const upstream = readFileSync(join(sourceDirectory, upstreamRelative));
    const packaged = readFileSync(join(legalRoot, packagedRelative));
    if (!upstream.equals(packaged)) {
      fail(`packaged legal file differs from the pinned source: ${packagedRelative}`);
    }
  }
  const notices = [
    [join(repositoryRoot, "LICENSE"), "WHITENIGHT-CODE-LICENSE"],
    [join(repositoryRoot, "NOTICE.md"), "WHITENIGHT-CODE-NOTICE.md"],
    [join(repositoryRoot, "THIRD-PARTY-NOTICES.md"), "THIRD-PARTY-NOTICES.md"],
    [join(sourceDirectory, "LICENSE"), "GROK-BUILD-LICENSE"],
    [join(sourceDirectory, "THIRD-PARTY-NOTICES"), "GROK-BUILD-THIRD-PARTY-NOTICES"],
    [join(sourceDirectory, "crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md"), "GROK-TOOLS-THIRD-PARTY-NOTICES.md"],
    [join(sourceDirectory, "crates/codegen/xai-ratatui-inline/NOTICE"), "XAI-RATATUI-INLINE-NOTICE"],
    [join(sourceDirectory, "crates/codegen/xai-ratatui-textarea/NOTICE"), "XAI-RATATUI-TEXTAREA-NOTICE"],
    [join(sourceDirectory, "third_party/NOTICE"), "GROK-VENDORED-NOTICE"],
  ];
  for (const [source, name] of notices) {
    const metadata = statSync(source);
    if (!metadata.isFile() || metadata.size === 0) fail(`required notice is missing or empty: ${source}`);
    copyFileSync(source, join(noticesDirectory, name));
  }

  const reportedVersion = captured(stagedBinary, ["--version"]);
  if (!reportedVersion.includes(lock.upstream.version)) {
    fail(`staged binary reports ${JSON.stringify(reportedVersion)}; expected ${lock.upstream.version}`);
  }

  const release = writeSidecarReleaseMetadata(stageDirectory, targetName);
  process.stdout.write(
    `${JSON.stringify({ target: targetName, binary: stagedBinary, version: reportedVersion, sha256: release.sha256, size: release.size, notices: notices.length })}\n`,
  );
}

main();
