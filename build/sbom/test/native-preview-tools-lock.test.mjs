// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const releaseRoot = new URL("../../release/", import.meta.url);
const lock = JSON.parse(fs.readFileSync(new URL("native-preview-tools.lock.json", releaseRoot), "utf8"));
const linuxScript = fs.readFileSync(new URL("native-preview-linux-x64.sh", releaseRoot), "utf8");
const windowsScript = fs.readFileSync(new URL("native-preview-windows-x64.ps1", releaseRoot), "utf8");

test("native remote builders pin every toolchain input", () => {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.node.version, "24.13.0");
  assert.equal(lock.yarn, "1.22.22");
  assert.equal(lock.rust, "1.92.0");
  assert.equal(lock.dotslash, "0.5.7");
  assert.equal(lock.protoc.version, "29.3");
  for (const target of ["linux-x64", "win32-x64"]) {
    for (const tool of [lock.node.targets[target], lock.protoc.targets[target]]) {
      assert.match(tool.url, /^https:\/\/(?:nodejs\.org|github\.com)\//u);
      assert.match(tool.sha256, /^[0-9a-f]{64}$/u);
      assert.ok(Number.isSafeInteger(tool.size) && tool.size > 0);
      assert.equal(tool.archive.includes(".."), false);
    }
  }
});

test("both native builders execute the release-blocking pipeline", () => {
  for (const script of [linuxScript, windowsScript]) {
    assert.match(script, /build\/grok\/build-sidecar\.mjs/u);
    assert.match(script, /build\/grok\/smoke-sidecar\.mjs/u);
    assert.match(script, /build\/grok\/release-metadata\.mjs/u);
    assert.match(script, /verify:sidecar:preview/u);
    assert.match(script, /package:preview:installers/u);
    assert.match(script, /sbom:preview/u);
    assert.match(script, /build\/sbom\/verify-preview-assets\.mjs/u);
  }
});

test("native builders require an externally verified archive and full commit", () => {
  assert.match(linuxScript, /--source-sha256/u);
  assert.match(linuxScript, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(windowsScript, /SourceSha256/u);
  assert.match(windowsScript, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(linuxScript, /archive\.pax_headers\.get\("comment"/u);
  assert.match(windowsScript, /pax_headers\.get\("comment"/u);
  assert.doesNotMatch(`${linuxScript}\n${windowsScript}`, /(?:password|api[_-]?key)\s*=/iu);
});

test("Windows verifies the Git archive commit without PowerShell 5 native argv quoting", () => {
  assert.doesNotMatch(windowsScript, /python\.exe -c \$archiveCommitScript/u);
  assert.match(windowsScript, /verify-archive-commit\.py/u);
  assert.match(windowsScript, /\[IO\.File\]::WriteAllText\(\$archiveCommitVerifier/u);
  assert.match(windowsScript, /Remove-Item -LiteralPath \$archiveCommitVerifier/u);
});

test("Windows activates the MSVC compiler and linker before cargo installs DotSlash", () => {
  const devShell = windowsScript.indexOf("Enter-VsDevShell");
  const cargoInstall = windowsScript.indexOf("'install', 'dotslash'");
  assert.ok(devShell >= 0, "Windows builder must activate Visual Studio DevShell");
  assert.ok(cargoInstall >= 0, "Windows builder must install pinned DotSlash");
  assert.ok(devShell < cargoInstall, "Visual Studio DevShell must be active before cargo install");
  assert.match(windowsScript, /Get-Command link\.exe/u);
});

test("Windows resolves its sibling tool lock after PowerShell 5.1 initializes PSScriptRoot", () => {
  assert.doesNotMatch(windowsScript, /\[string\]\$ToolLock\s*=\s*\(Join-Path\s+\$PSScriptRoot/u);
  assert.match(windowsScript, /if \(\[string\]::IsNullOrWhiteSpace\(\$ToolLock\)\)[\s\S]*?Join-Path \$PSScriptRoot 'native-preview-tools\.lock\.json'/u);
});

test("native builders retry dependency installation only a bounded number of times", () => {
  assert.match(linuxScript, /run_with_retry 3 10 yarn install --frozen-lockfile --non-interactive/u);
  assert.match(linuxScript, /if \(\(attempt >= attempts\)\); then[\s\S]*?return "\$status"/u);
  assert.match(windowsScript, /function Invoke-CheckedWithRetry/u);
  assert.match(windowsScript, /\$attempt -ge \$Attempts[\s\S]*?throw/u);
  assert.match(windowsScript, /Invoke-CheckedWithRetry -File \$YarnExecutable[\s\S]*?-Attempts 3 -DelaySeconds 10/u);

  const linuxInstall = linuxScript.indexOf("run_with_retry 3 10 yarn install");
  const windowsInstall = windowsScript.indexOf("Invoke-CheckedWithRetry -File $YarnExecutable");
  assert.ok(linuxInstall >= 0);
  assert.ok(windowsInstall >= 0);
  assert.equal(linuxScript.slice(linuxInstall).match(/run_with_retry 3 10 yarn install/gu)?.length, 1);
  assert.equal(windowsScript.slice(windowsInstall).match(/Invoke-CheckedWithRetry -File \$YarnExecutable/gu)?.length, 1);
});

test("native builders clear ambient runtime and compiler injection hooks", () => {
  for (const script of [linuxScript, windowsScript]) {
    for (const name of ["NODE_OPTIONS", "PYTHONPATH", "RUSTC_WRAPPER", "CARGO_BUILD_TARGET", "CARGO_ENCODED_RUSTFLAGS"]) {
      assert.match(script, new RegExp(`\\b${name}\\b`, "u"));
    }
  }
  assert.match(linuxScript, /unset "\$ambient_override"/u);
  assert.match(windowsScript, /Remove-Item -LiteralPath "Env:\$ambientOverride"/u);
});

test("Linux rejects lexical traversal before creating native build directories", () => {
  assert.match(linuxScript, /assert_clean_absolute_path "\$work_root"/u);
  assert.match(linuxScript, /assert_clean_absolute_path "\$output_directory"/u);
  assert.match(linuxScript, /assert_clean_absolute_path "\$tool_cache"/u);
  assert.match(linuxScript, /"\/\.\.\/"/u);
  assert.match(linuxScript, /"\/\.\/"/u);
});

test("native builders isolate Cargo on the official sparse crates.io index", () => {
  for (const script of [linuxScript, windowsScript]) {
    assert.match(script, /cargo-home/u);
    assert.match(script, /sparse\+https:\/\/index\.crates\.io\//u);
    assert.match(script, /protocol = "sparse"/u);
    assert.match(script, /retry = 6/u);
    assert.match(script, /timeout = 120/u);
    assert.doesNotMatch(script, /replace-with\s*=/u);
    assert.doesNotMatch(script, /(?:mirrors?\.ustc|ustc\.edu)/iu);
  }

  const linuxRustup = linuxScript.indexOf('rustup toolchain install');
  const linuxCargoHome = linuxScript.indexOf('export CARGO_HOME="$cargo_home"');
  const linuxDotSlash = linuxScript.indexOf('cargo install dotslash');
  const linuxSidecar = linuxScript.indexOf('node build/grok/build-sidecar.mjs');
  assert.ok(linuxRustup < linuxCargoHome && linuxCargoHome < linuxDotSlash && linuxDotSlash < linuxSidecar);

  const windowsRustup = windowsScript.indexOf("'toolchain', 'install'");
  const windowsCargoHome = windowsScript.indexOf('$env:CARGO_HOME = $CargoHome');
  const windowsDotSlash = windowsScript.indexOf("'install', 'dotslash'");
  const windowsSidecar = windowsScript.indexOf("'build/grok/build-sidecar.mjs'");
  assert.ok(windowsRustup < windowsCargoHome && windowsCargoHome < windowsDotSlash && windowsDotSlash < windowsSidecar);
});
