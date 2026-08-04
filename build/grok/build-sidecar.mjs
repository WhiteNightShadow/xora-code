#!/usr/bin/env node
// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSidecarReleaseMetadata } from "./release-metadata.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const lockPath = join(scriptDirectory, "sidecar.lock.json");
const encodedRustFlagSeparator = "\u001f";
const requiredRustCodegenFlags = ["-Cdebuginfo=0", "-Cstrip=symbols"];

function fail(message) {
  throw new Error(`Grok sidecar build refused: ${message}`);
}

export function createRustPathRemaps({
  workDirectory,
  sourceDirectory,
  targetDirectory,
  homeDirectory,
  cargoHome,
  rustupHome,
}) {
  const candidates = [
    ["source directory", sourceDirectory, "/xora-build/source"],
    ["target directory", targetDirectory, "/xora-build/target"],
    ["work directory", workDirectory, "/xora-build"],
    ["Cargo home", cargoHome, "/xora-cache/cargo"],
    ["Rustup home", rustupHome, "/xora-cache/rustup"],
    ["home directory", homeDirectory, "/xora-home"],
  ];
  const seen = new Set();
  return candidates.flatMap(([label, from, to]) => {
    if (typeof from !== "string" || from.length < 3 || seen.has(from)) return [];
    seen.add(from);
    return [{ label, from, to }];
  });
}

function rustFlagsFor(pathRemaps) {
  return [
    ...pathRemaps.map(({ from, to }) => `--remap-path-prefix=${from}=${to}`),
    ...requiredRustCodegenFlags,
  ];
}

function shellEscapeCompilerArgument(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function nativeCompilerFlagsFor(pathRemaps, rustTarget) {
  if (rustTarget.endsWith("-pc-windows-msvc")) {
    // MSVC accepts /pathmap without failing when deterministic mode is absent,
    // but silently ignores it (D9007). Keep the prerequisite next to every
    // audited mapping so native dependency diagnostics cannot retain runner
    // paths on newer Visual Studio toolchains.
    return [
      "/experimental:deterministic",
      ...pathRemaps.map(({ from, to }) => `/pathmap:${from}=${to}`),
    ];
  }
  return pathRemaps.map(({ from, to }) => `-ffile-prefix-map=${from}=${to}`);
}

function cargoEnvironment({ targetDirectory, pathRemaps, rustTarget, environment }) {
  const env = {
    ...environment,
    CARGO_INCREMENTAL: "0",
    CARGO_TARGET_DIR: targetDirectory,
    SOURCE_DATE_EPOCH: "0",
    CARGO_ENCODED_RUSTFLAGS: rustFlagsFor(pathRemaps).join(encodedRustFlagSeparator),
  };
  // CARGO_ENCODED_RUSTFLAGS is the single audited source of rustc flags. Drop
  // ambient alternatives so local shells and CI runners cannot weaken the
  // path-remap or symbol-stripping policy.
  delete env.RUSTFLAGS;
  delete env.CARGO_BUILD_RUSTFLAGS;
  for (const name of Object.keys(env)) {
    if (/^CARGO_TARGET_.*_RUSTFLAGS$/u.test(name)) delete env[name];
    if (/^(?:CFLAGS|CXXFLAGS)(?:_|$)/u.test(name)) delete env[name];
  }
  delete env.CPPFLAGS;
  delete env.CL;
  delete env._CL_;
  delete env.CC_SHELL_ESCAPED_FLAGS;
  delete env.AWS_LC_SYS_CMAKE_BUILDER;

  // Rust path remapping does not cover C/C++ sources compiled by crates such
  // as tree-sitter. Apply the equivalent native compiler policy so __FILE__
  // and diagnostic strings cannot disclose a runner or shared cache path.
  const nativeCompilerFlags = nativeCompilerFlagsFor(pathRemaps, rustTarget)
    .map(shellEscapeCompilerArgument)
    .join(" ");
  env.CC_SHELL_ESCAPED_FLAGS = "1";
  env.CFLAGS = nativeCompilerFlags;
  env.CXXFLAGS = nativeCompilerFlags;
  if (rustTarget.endsWith("-pc-windows-msvc")) {
    // aws-lc-sys 0.39.1's cc builder only compiles its builtin-swap probe.
    // MSVC 14.44 accepts the undeclared builtin calls and fails much later at
    // link time. The upstream CMake path performs a complete feature check and
    // correctly falls back to the MSVC byte-swap intrinsics.
    env.AWS_LC_SYS_CMAKE_BUILDER = "1";
  }
  return env;
}

export function createRipgrepInstallPlan({
  lock,
  installRoot,
  targetDirectory,
  pathRemaps,
  rustTarget,
  environment = process.env,
}) {
  const ripgrep = lock.bundledTools.ripgrep;
  return {
    file: "cargo",
    args: [
      "install",
      "--locked",
      "--force",
      "--version",
      `=${ripgrep.version}`,
      "--features",
      ripgrep.features.join(","),
      "--root",
      installRoot,
      "--target-dir",
      targetDirectory,
      ripgrep.package,
    ],
    env: cargoEnvironment({ targetDirectory, pathRemaps, rustTarget, environment }),
  };
}

export function assertRipgrepInstallPlan(plan, { lock, installRoot, targetDirectory, pathRemaps, rustTarget }) {
  const ripgrep = lock.bundledTools.ripgrep;
  const expectedArgs = [
    "install",
    "--locked",
    "--force",
    "--version",
    `=${ripgrep.version}`,
    "--features",
    ripgrep.features.join(","),
    "--root",
    installRoot,
    "--target-dir",
    targetDirectory,
    ripgrep.package,
  ];
  if (plan.file !== "cargo" || JSON.stringify(plan.args) !== JSON.stringify(expectedArgs)) {
    fail("ripgrep Cargo install command differs from the audited locked source build");
  }
  assertCargoEnvironment(plan.env, { targetDirectory, pathRemaps, rustTarget });
}

export function createCargoBuildPlan({
  lock,
  targetDirectory,
  pathRemaps,
  rustTarget,
  bundledRipgrepPath,
  environment = process.env,
}) {
  const env = cargoEnvironment({ targetDirectory, pathRemaps, rustTarget, environment });
  if (bundledRipgrepPath !== undefined) {
    env.GROK_SHELL_BUNDLE_RG_PATH = bundledRipgrepPath;
    env.GROK_TOOLS_BUNDLE_RG_PATH = bundledRipgrepPath;
  }
  return {
    file: "cargo",
    args: ["build", "-p", lock.toolchain.cargoPackage, "--profile", lock.toolchain.cargoProfile],
    env,
  };
}

function assertCargoEnvironment(env, { targetDirectory, pathRemaps, rustTarget }) {
  if (
    env.CARGO_INCREMENTAL !== "0" ||
    env.CARGO_TARGET_DIR !== targetDirectory ||
    env.SOURCE_DATE_EPOCH !== "0"
  ) {
    fail("Cargo reproducibility environment is incomplete");
  }
  const expectedRustFlags = rustFlagsFor(pathRemaps);
  const actualRustFlags = env.CARGO_ENCODED_RUSTFLAGS?.split(encodedRustFlagSeparator) ?? [];
  if (JSON.stringify(actualRustFlags) !== JSON.stringify(expectedRustFlags)) {
    fail("encoded Rust flags must exactly enforce path remapping and symbol stripping");
  }
  const expectedNativeCompilerFlags = nativeCompilerFlagsFor(pathRemaps, rustTarget)
    .map(shellEscapeCompilerArgument)
    .join(" ");
  if (
    env.CC_SHELL_ESCAPED_FLAGS !== "1" ||
    env.CFLAGS !== expectedNativeCompilerFlags ||
    env.CXXFLAGS !== expectedNativeCompilerFlags
  ) {
    fail("native compiler flags must exactly enforce path remapping");
  }
  const expectsWindowsCmake = rustTarget.endsWith("-pc-windows-msvc");
  if ((env.AWS_LC_SYS_CMAKE_BUILDER === "1") !== expectsWindowsCmake) {
    fail("AWS-LC builder policy differs from the audited native target policy");
  }
  if (
    env.RUSTFLAGS !== undefined ||
    env.CARGO_BUILD_RUSTFLAGS !== undefined ||
    env.CPPFLAGS !== undefined ||
    env.CL !== undefined ||
    env._CL_ !== undefined ||
    Object.keys(env).some((name) =>
      /^CARGO_TARGET_.*_RUSTFLAGS$/u.test(name) ||
      (/^(?:CFLAGS|CXXFLAGS)_/u.test(name)))
  ) {
    fail("ambient compiler flags must not override the audited build policy");
  }
}

export function assertCargoBuildPlan(plan, {
  lock,
  targetDirectory,
  pathRemaps,
  rustTarget,
  bundledRipgrepPath,
}) {
  const expectedArgs = ["build", "-p", lock.toolchain.cargoPackage, "--profile", lock.toolchain.cargoProfile];
  if (plan.file !== "cargo" || JSON.stringify(plan.args) !== JSON.stringify(expectedArgs)) {
    fail("Cargo command differs from the audited package/profile invocation");
  }
  assertCargoEnvironment(plan.env, { targetDirectory, pathRemaps, rustTarget });
  if (
    plan.env.GROK_SHELL_BUNDLE_RG_PATH !== bundledRipgrepPath ||
    plan.env.GROK_TOOLS_BUNDLE_RG_PATH !== bundledRipgrepPath
  ) {
    fail("both Grok crates must bundle the same audited ripgrep binary");
  }
}

function pathVariants(value) {
  const variants = new Set([value, value.replaceAll("\\", "/"), value.replaceAll("/", "\\")]);
  if (/^[A-Za-z]:/u.test(value)) {
    variants.add(`${value[0].toLowerCase()}${value.slice(1)}`);
    variants.add(`${value[0].toUpperCase()}${value.slice(1)}`);
  }
  return [...variants];
}

export function assertNoEmbeddedBuildPaths(binaryPath, pathRemaps) {
  const binary = readFileSync(binaryPath);
  for (const { label, from } of pathRemaps) {
    for (const variant of pathVariants(from)) {
      if (binary.includes(Buffer.from(variant, "utf8")) || binary.includes(Buffer.from(variant, "utf16le"))) {
        fail(`staged binary still contains an unremapped ${label}`);
      }
    }
  }
}

function detectedNativeArchitecture(binary) {
  if (binary.length >= 20 && binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (binary[4] !== 2 || binary[5] !== 1) return undefined;
    const machine = binary.readUInt16LE(18);
    if (machine === 0x3e) return "x86_64-unknown-linux-gnu";
    if (machine === 0xb7) return "aarch64-unknown-linux-gnu";
    return undefined;
  }
  if (binary.length >= 8 && binary.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = binary.readUInt32LE(4);
    if (cpu === 0x01000007) return "x86_64-apple-darwin";
    if (cpu === 0x0100000c) return "aarch64-apple-darwin";
    return undefined;
  }
  if (binary.length >= 0x40 && binary[0] === 0x4d && binary[1] === 0x5a) {
    const header = binary.readUInt32LE(0x3c);
    if (header + 6 > binary.length || binary.readUInt32LE(header) !== 0x00004550) return undefined;
    const machine = binary.readUInt16LE(header + 4);
    if (machine === 0x8664) return "x86_64-pc-windows-msvc";
    if (machine === 0xaa64) return "aarch64-pc-windows-msvc";
  }
  return undefined;
}

export function assertNativeBinaryArchitecture(binaryPath, target) {
  const actual = detectedNativeArchitecture(readFileSync(binaryPath));
  if (actual !== target.rustTarget) {
    fail(`native binary architecture is ${actual ?? "unknown"}; expected ${target.rustTarget}`);
  }
}

export function assertRipgrepVersion(versionOutput, expectedVersion) {
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^ripgrep ${escaped}(?:\\r?\\n|$)`, "u").test(versionOutput)) {
    fail(`bundled ripgrep reports ${JSON.stringify(versionOutput)}; expected ${expectedVersion}`);
  }
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
  let origin;
  try {
    // Read the literal repository setting. `git remote get-url` expands a
    // machine-local `url.*.insteadOf` cache/proxy rule and would make a pinned
    // official origin appear different even though `.git/config` is correct.
    origin = captured("git", ["config", "--get", "remote.origin.url"], { cwd: sourceDirectory });
  } catch {
    run("git", ["remote", "add", "origin", lock.upstream.repository], { cwd: sourceDirectory });
    origin = lock.upstream.repository;
  }
  if (origin !== lock.upstream.repository) {
    fail(`existing build checkout uses an unexpected origin: ${origin}`);
  }
  run("git", ["fetch", "--depth=1", "origin", lock.upstream.commit], { cwd: sourceDirectory });
  run("git", ["checkout", "--detach", "--quiet", "FETCH_HEAD"], { cwd: sourceDirectory });
  assertExactSource(sourceDirectory, lock);
}

export function applySourcePatches({ sourceDirectory, lock, targetName }) {
  const patches = lock.sourcePatches ?? [];
  for (const patch of patches) {
    if (!patch.targets.includes(targetName)) continue;
    const patchPath = resolve(scriptDirectory, patch.file);
    if (!patchPath.startsWith(`${scriptDirectory}${sep}`)) {
      fail(`source patch escapes build/grok: ${patch.file}`);
    }
    const bytes = readFileSync(patchPath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== patch.sha256) {
      fail(`source patch ${patch.id} has SHA-256 ${actualHash}; expected ${patch.sha256}`);
    }
    run("git", ["apply", "--check", patchPath], { cwd: sourceDirectory });
    run("git", ["apply", patchPath], { cwd: sourceDirectory });
  }
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
  const ripgrepInstallRoot = join(workDirectory, "ripgrep-install-pcre2");
  const ripgrepTargetDirectory = join(targetDirectory, "ripgrep");
  mkdirSync(workDirectory, { recursive: true });
  checkoutExactSource(sourceDirectory, lock);
  applySourcePatches({ sourceDirectory, lock, targetName });
  assertNativeToolchain(lock, target);

  const homeDirectory = homedir();
  const pathRemaps = createRustPathRemaps({
    workDirectory,
    sourceDirectory,
    targetDirectory,
    homeDirectory,
    cargoHome: resolve(process.env.CARGO_HOME ?? join(homeDirectory, ".cargo")),
    rustupHome: resolve(process.env.RUSTUP_HOME ?? join(homeDirectory, ".rustup")),
  });
  const ripgrepInstall = createRipgrepInstallPlan({
    lock,
    installRoot: ripgrepInstallRoot,
    targetDirectory: ripgrepTargetDirectory,
    pathRemaps,
    rustTarget: target.rustTarget,
  });
  assertRipgrepInstallPlan(ripgrepInstall, {
    lock,
    installRoot: ripgrepInstallRoot,
    targetDirectory: ripgrepTargetDirectory,
    pathRemaps,
    rustTarget: target.rustTarget,
  });
  run(ripgrepInstall.file, ripgrepInstall.args, { cwd: workDirectory, env: ripgrepInstall.env });

  const ripgrep = lock.bundledTools.ripgrep;
  const ripgrepBinary = join(
    ripgrepInstallRoot,
    "bin",
    `${ripgrep.binary}${target.executableSuffix}`,
  );
  const ripgrepStat = lstatSync(ripgrepBinary);
  if (!ripgrepStat.isFile() || ripgrepStat.isSymbolicLink() || ripgrepStat.size === 0) {
    fail(`Cargo did not install ${ripgrepBinary}`);
  }
  const reportedRipgrepVersion = captured(ripgrepBinary, ["--version"]);
  assertRipgrepVersion(reportedRipgrepVersion, ripgrep.version);
  assertNativeBinaryArchitecture(ripgrepBinary, target);
  assertNoEmbeddedBuildPaths(ripgrepBinary, pathRemaps);

  const cargoBuild = createCargoBuildPlan({
    lock,
    targetDirectory,
    pathRemaps,
    rustTarget: target.rustTarget,
    bundledRipgrepPath: ripgrepBinary,
  });
  assertCargoBuildPlan(cargoBuild, {
    lock,
    targetDirectory,
    pathRemaps,
    rustTarget: target.rustTarget,
    bundledRipgrepPath: ripgrepBinary,
  });
  if (process.platform === "win32") {
    const protoc = captured("where.exe", ["protoc.exe"]).split(/\r?\n/u)[0];
    const protocVersion = captured(protoc, ["--version"]);
    if (protocVersion !== `libprotoc ${lock.toolchain.protoc}`) {
      fail(`Windows protoc reports ${JSON.stringify(protocVersion)}; expected libprotoc ${lock.toolchain.protoc}`);
    }
    cargoBuild.env.PROTOC = protoc;
  }
  // Keep this invocation aligned with the audited command in sidecar.lock.json.
  run(cargoBuild.file, cargoBuild.args, { cwd: sourceDirectory, env: cargoBuild.env });

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
  assertNoEmbeddedBuildPaths(stagedBinary, pathRemaps);

  // Theia's npm-provided ripgrep executable can retain paths from its upstream
  // build machine. Stage the same audited source build as a packaging helper;
  // native afterPack hooks verify it, replace Theia's copy, then remove this
  // helper so the application does not ship a redundant executable.
  const helperDirectory = join(stageDirectory, "packaging-tools");
  rmSync(helperDirectory, { recursive: true, force: true });
  mkdirSync(helperDirectory, { recursive: true });
  const helperName = `${ripgrep.binary}${target.executableSuffix}`;
  const helperBinary = join(helperDirectory, helperName);
  copyFileSync(ripgrepBinary, helperBinary);
  if (target.executableSuffix === "") chmodSync(helperBinary, 0o755);
  assertRipgrepVersion(captured(helperBinary, ["--version"]), ripgrep.version);
  assertNativeBinaryArchitecture(helperBinary, target);
  assertNoEmbeddedBuildPaths(helperBinary, pathRemaps);
  const helperHash = createHash("sha256").update(readFileSync(helperBinary)).digest("hex");
  writeFileSync(join(helperDirectory, `${helperName}.sha256`), `${helperHash}  ${helperName}\n`, "utf8");

  const noticesDirectory = join(stageDirectory, "notices");
  // The stage directory can be reused by local and CI builds. Remove notices
  // from a previous product name/version so renamed or retired legal files can
  // never leak into a newly packaged sidecar.
  rmSync(noticesDirectory, { recursive: true, force: true });
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
    [join(repositoryRoot, "LICENSE"), "XORA-CODE-LICENSE"],
    [join(repositoryRoot, "NOTICE.md"), "XORA-CODE-NOTICE.md"],
    [join(repositoryRoot, "THIRD-PARTY-NOTICES.md"), "THIRD-PARTY-NOTICES.md"],
    [join(repositoryRoot, "resources/legal/ripgrep/RIPGREP-SOURCE-BUILD-NOTICE.md"), "RIPGREP-SOURCE-BUILD-NOTICE.md"],
    [join(repositoryRoot, "build/grok/PATCHES.md"), "GROK-BUILD-COMPATIBILITY-PATCHES.md"],
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
    `${JSON.stringify({ target: targetName, binary: stagedBinary, version: reportedVersion, bundledRipgrepVersion: ripgrep.version, sha256: release.sha256, size: release.size, notices: notices.length })}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
