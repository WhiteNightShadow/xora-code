import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applySourcePatches,
  assertCargoBuildPlan,
  assertNativeBinaryArchitecture,
  assertNoEmbeddedBuildPaths,
  assertRipgrepInstallPlan,
  assertRipgrepVersion,
  createCargoBuildPlan,
  createRipgrepInstallPlan,
  createRustPathRemaps,
} from "../build-sidecar.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const signScript = join(repositoryRoot, "build/grok/sign-release-manifests.mjs");
const collectScript = join(repositoryRoot, "build/grok/collect-release-assets.mjs");
const verifyKeysScript = join(repositoryRoot, "build/grok/verify-release-key-configuration.mjs");
const smokeScript = join(repositoryRoot, "build/grok/smoke-sidecar.mjs");
const buildScript = join(repositoryRoot, "build/grok/build-sidecar.mjs");

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function encodedPrivateKey(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

async function createAssets(directory) {
  const names = [
    "Xora Code-0.1.0-mac-arm64.dmg",
    "Xora Code-0.1.0-mac-x64.zip",
    "Xora Code-0.1.0-win-x64.exe",
    "Xora Code-0.1.0-linux-x64.AppImage",
    "Xora Code-0.1.0-linux-x64.deb",
    "Xora-Code-Grok-Build-0.2.102-darwin-arm64",
    "Xora-Code-Grok-Build-0.2.102-darwin-x64",
    "Xora-Code-Grok-Build-0.2.102-win32-x64.exe",
    "Xora-Code-Grok-Build-0.2.102-linux-x64",
    "Xora-Code-Grok-Build-0.2.102-darwin-arm64.tar.gz",
    "Xora-Code-Grok-Build-0.2.102-darwin-x64.tar.gz",
    "Xora-Code-Grok-Build-0.2.102-win32-x64.zip",
    "Xora-Code-Grok-Build-0.2.102-linux-x64.tar.gz",
  ];
  await mkdir(directory, { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(directory, name), `fixture:${name}`, "utf8")));
}

async function createFakeGrok(path, body) {
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  const version = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.2\.102/u);
}

test("sidecar staging removes stale renamed notices before packaging", async () => {
  const source = await readFile(buildScript, "utf8");
  const cleanup = source.indexOf("rmSync(noticesDirectory, { recursive: true, force: true })");
  const copy = source.indexOf("copyFileSync(source, join(noticesDirectory, name))");
  assert.ok(cleanup >= 0 && copy > cleanup, "notice cleanup must run before the audited notice copy");
  assert.match(source, /XORA-CODE-LICENSE/u);
  assert.doesNotMatch(source, /\[join\(repositoryRoot, "LICENSE"\), "WHITENIGHT-CODE-LICENSE"\]/u);
});

test("Windows source compatibility patch is target-scoped and digest-pinned", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-grok-patch-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "source");
  await mkdir(join(sourceDirectory, "crates/build/xai-proto-build/src"), { recursive: true });
  const original = `fn marker() {\n    let _ = "/dev/stdout";\n}\n`;
  const sourcePath = join(sourceDirectory, "crates/build/xai-proto-build/src/lib.rs");
  await writeFile(sourcePath, original, "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: sourceDirectory });
  const patchBytes = `diff --git a/crates/build/xai-proto-build/src/lib.rs b/crates/build/xai-proto-build/src/lib.rs\n--- a/crates/build/xai-proto-build/src/lib.rs\n+++ b/crates/build/xai-proto-build/src/lib.rs\n@@ -1,3 +1,3 @@\n fn marker() {\n-    let _ = "/dev/stdout";\n+    let _ = "portable";\n }\n`;
  const hash = createHash("sha256").update(patchBytes).digest("hex");
  const relativePatch = `patches/${Date.now()}-fixture.patch`;
  const repositoryPatch = join(repositoryRoot, "build/grok", relativePatch);
  await writeFile(repositoryPatch, patchBytes, "utf8");
  context.after(() => rm(repositoryPatch, { force: true }));
  const lock = { sourcePatches: [{ id: "fixture", targets: ["win32-x64"], file: relativePatch, sha256: hash }] };

  applySourcePatches({ sourceDirectory, lock, targetName: "linux-x64" });
  assert.equal(await readFile(sourcePath, "utf8"), original);
  applySourcePatches({ sourceDirectory, lock, targetName: "win32-x64" });
  assert.match(await readFile(sourcePath, "utf8"), /portable/u);
});

test("sidecar and source-built ripgrep Cargo plans are pinned, remapped, and stripped", () => {
  const lock = {
    toolchain: { cargoPackage: "xai-grok-pager-bin", cargoProfile: "release-dist" },
    bundledTools: { ripgrep: { package: "ripgrep", version: "15.0.0", binary: "rg", source: "crates.io", features: ["pcre2"] } },
  };
  const fixtures = [
    {
      workDirectory: "/private/tmp/xora build",
      sourceDirectory: "/private/tmp/xora build/source",
      targetDirectory: "/private/tmp/xora build/target",
      homeDirectory: "/Users/build user",
      cargoHome: "/Users/build user/.cargo",
      rustupHome: "/Users/build user/.rustup",
      rustTarget: "aarch64-apple-darwin",
      ambientTargetFlags: "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS",
    },
    {
      workDirectory: String.raw`C:\runner temp\xora build`,
      sourceDirectory: String.raw`C:\runner temp\xora build\source`,
      targetDirectory: String.raw`C:\runner temp\xora build\target`,
      homeDirectory: String.raw`C:\Users\builder`,
      cargoHome: String.raw`C:\Users\builder\.cargo`,
      rustupHome: String.raw`C:\Users\builder\.rustup`,
      rustTarget: "x86_64-pc-windows-msvc",
      ambientTargetFlags: "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
    },
  ];

  for (const fixture of fixtures) {
    const pathRemaps = createRustPathRemaps(fixture);
    const ripgrepInstallRoot = `${fixture.workDirectory}/ripgrep-install-pcre2`;
    const ripgrepTargetDirectory = `${fixture.targetDirectory}/ripgrep`;
    const bundledRipgrepPath = `${ripgrepInstallRoot}/bin/rg${fixture.workDirectory.startsWith("C:") ? ".exe" : ""}`;
    const environment = {
      PATH: "/fixture/bin",
      CARGO_HOME: fixture.cargoHome,
      RUSTFLAGS: "-Cdebuginfo=2",
      CARGO_ENCODED_RUSTFLAGS: "ambient",
      CARGO_BUILD_RUSTFLAGS: "ambient",
      CFLAGS: "ambient",
      CXXFLAGS_x86_64_unknown_linux_gnu: "ambient",
      CPPFLAGS: "ambient",
      CL: "ambient",
      AWS_LC_SYS_CMAKE_BUILDER: "0",
      [fixture.ambientTargetFlags]: "ambient",
    };
    const ripgrepInstall = createRipgrepInstallPlan({
      lock,
      installRoot: ripgrepInstallRoot,
      targetDirectory: ripgrepTargetDirectory,
      pathRemaps,
      rustTarget: fixture.rustTarget,
      environment,
    });
    assert.deepEqual(ripgrepInstall.args, [
      "install", "--locked", "--force", "--version", "=15.0.0",
      "--features", "pcre2",
      "--root", ripgrepInstallRoot,
      "--target-dir", ripgrepTargetDirectory,
      "ripgrep",
    ]);
    assert.equal(ripgrepInstall.env.CARGO_HOME, fixture.cargoHome);
    assert.doesNotThrow(() => assertRipgrepInstallPlan(ripgrepInstall, {
      lock,
      installRoot: ripgrepInstallRoot,
      targetDirectory: ripgrepTargetDirectory,
      pathRemaps,
      rustTarget: fixture.rustTarget,
    }));

    const plan = createCargoBuildPlan({
      lock,
      targetDirectory: fixture.targetDirectory,
      pathRemaps,
      rustTarget: fixture.rustTarget,
      bundledRipgrepPath,
      environment,
    });
    assert.deepEqual(plan.args, ["build", "-p", "xai-grok-pager-bin", "--profile", "release-dist"]);
    assert.equal(plan.env.CARGO_INCREMENTAL, "0");
    assert.equal(plan.env.CARGO_HOME, fixture.cargoHome);
    assert.equal(plan.env.CARGO_TARGET_DIR, fixture.targetDirectory);
    assert.equal(plan.env.SOURCE_DATE_EPOCH, "0");
    assert.equal(plan.env.RUSTFLAGS, undefined);
    assert.equal(plan.env.CARGO_BUILD_RUSTFLAGS, undefined);
    assert.equal(plan.env[fixture.ambientTargetFlags], undefined);
    assert.equal(plan.env.CPPFLAGS, undefined);
    assert.equal(plan.env.CL, undefined);
    assert.equal(plan.env.CXXFLAGS_x86_64_unknown_linux_gnu, undefined);
    assert.equal(plan.env.CC_SHELL_ESCAPED_FLAGS, "1");
    const windows = fixture.rustTarget.endsWith("-pc-windows-msvc");
    const nativeArguments = windows
      ? ["/experimental:deterministic", ...pathRemaps.map(({ from, to }) => `/pathmap:${from}=${to}`)]
      : pathRemaps.map(({ from, to }) => `-ffile-prefix-map=${from}=${to}`);
    const nativeFlags = nativeArguments.map(argument => `'${argument}'`).join(" ");
    assert.equal(plan.env.CFLAGS, nativeFlags);
    assert.equal(plan.env.CXXFLAGS, nativeFlags);
    assert.equal(plan.env.AWS_LC_SYS_CMAKE_BUILDER, windows ? "1" : undefined);
    assert.equal(plan.env.GROK_SHELL_BUNDLE_RG_PATH, bundledRipgrepPath);
    assert.equal(plan.env.GROK_TOOLS_BUNDLE_RG_PATH, bundledRipgrepPath);
    const flags = plan.env.CARGO_ENCODED_RUSTFLAGS.split("\u001f");
    assert.deepEqual(
      flags.slice(0, pathRemaps.length),
      pathRemaps.map(({ from, to }) => `--remap-path-prefix=${from}=${to}`),
    );
    assert.deepEqual(flags.slice(-2), ["-Cdebuginfo=0", "-Cstrip=symbols"]);
    assert.doesNotThrow(() => assertCargoBuildPlan(plan, {
      lock,
      targetDirectory: fixture.targetDirectory,
      pathRemaps,
      rustTarget: fixture.rustTarget,
      bundledRipgrepPath,
    }));

    const weakened = {
      ...plan,
      env: { ...plan.env, CARGO_ENCODED_RUSTFLAGS: flags.slice(0, -1).join("\u001f") },
    };
    assert.throws(
      () => assertCargoBuildPlan(weakened, {
        lock,
        targetDirectory: fixture.targetDirectory,
        pathRemaps,
        rustTarget: fixture.rustTarget,
        bundledRipgrepPath,
      }),
      /path remapping and symbol stripping/u,
    );

    const splitBundle = {
      ...plan,
      env: { ...plan.env, GROK_TOOLS_BUNDLE_RG_PATH: `${bundledRipgrepPath}.other` },
    };
    assert.throws(
      () => assertCargoBuildPlan(splitBundle, {
        lock,
        targetDirectory: fixture.targetDirectory,
        pathRemaps,
        rustTarget: fixture.rustTarget,
        bundledRipgrepPath,
      }),
      /same audited ripgrep binary/u,
    );
  }
});

test("source-built ripgrep version and native architecture checks fail closed", async (context) => {
  assert.doesNotThrow(() => assertRipgrepVersion("ripgrep 15.0.0\nfeatures:+pcre2", "15.0.0"));
  assert.throws(() => assertRipgrepVersion("ripgrep 15.0.1", "15.0.0"), /expected 15\.0\.0/u);

  const root = await mkdtemp(join(tmpdir(), "xora-ripgrep-arch-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    ["linux-x64", "x86_64-unknown-linux-gnu", (() => {
      const bytes = Buffer.alloc(64);
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
      bytes.writeUInt16LE(0x3e, 18);
      return bytes;
    })()],
    ["linux-arm64", "aarch64-unknown-linux-gnu", (() => {
      const bytes = Buffer.alloc(64);
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
      bytes.writeUInt16LE(0xb7, 18);
      return bytes;
    })()],
    ["mac-arm64", "aarch64-apple-darwin", (() => {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(0x0100000c, 4);
      return bytes;
    })()],
    ["mac-x64", "x86_64-apple-darwin", (() => {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(0x01000007, 4);
      return bytes;
    })()],
    ["windows-x64.exe", "x86_64-pc-windows-msvc", (() => {
      const bytes = Buffer.alloc(256);
      bytes.write("MZ", 0, "ascii");
      bytes.writeUInt32LE(0x80, 0x3c);
      bytes.writeUInt32LE(0x00004550, 0x80);
      bytes.writeUInt16LE(0x8664, 0x84);
      return bytes;
    })()],
  ];
  for (const [name, rustTarget, bytes] of fixtures) {
    const binary = join(root, name);
    await writeFile(binary, bytes);
    assert.doesNotThrow(() => assertNativeBinaryArchitecture(binary, { rustTarget }));
  }
  assert.throws(
    () => assertNativeBinaryArchitecture(join(root, "mac-arm64"), { rustTarget: "x86_64-apple-darwin" }),
    /expected x86_64-apple-darwin/u,
  );
});

test("sidecar build rejects binaries containing ASCII or UTF-16 build roots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-sidecar-path-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "grok-fixture");
  const pathRemaps = createRustPathRemaps({
    workDirectory: "/private/tmp/xora-build",
    sourceDirectory: "/private/tmp/xora-build/source",
    targetDirectory: "/private/tmp/xora-build/target",
    homeDirectory: String.raw`C:\Users\builder`,
    cargoHome: String.raw`C:\Users\builder\.cargo`,
    rustupHome: String.raw`C:\Users\builder\.rustup`,
  });

  await writeFile(binary, Buffer.from("debug path: /private/tmp/xora-build/source/main.rs", "utf8"));
  assert.throws(() => assertNoEmbeddedBuildPaths(binary, pathRemaps), /unremapped source directory/u);

  await writeFile(binary, Buffer.from(String.raw`C:\Users\builder\.cargo\registry`, "utf16le"));
  assert.throws(() => assertNoEmbeddedBuildPaths(binary, pathRemaps), /unremapped Cargo home/u);

  await writeFile(binary, Buffer.from("sanitized:/xora-build/source/main.rs", "utf8"));
  assert.doesNotThrow(() => assertNoEmbeddedBuildPaths(binary, pathRemaps));
});

test("ACP smoke keeps eager model discovery on a loopback fixture", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-sidecar-smoke-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "fake-grok.mjs");
  await createFakeGrok(binary, `
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.102 (smoke fixture)\\n");
  process.exit(0);
}
const modelBase = process.env.GROK_XAI_API_BASE_URL;
const modelUrl = new URL(modelBase ?? "http://invalid");
if (modelUrl.protocol !== "http:" || modelUrl.hostname !== "127.0.0.1" || !modelUrl.port || modelUrl.pathname !== "/v1") {
  process.stderr.write("model endpoint was not confined to loopback\\n");
  process.exit(20);
}
const models = await fetch(modelBase + "/models").then((response) => response.json());
if (!Array.isArray(models.data)) process.exit(21);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { authMethods: [{ id: "xai.api_key" }] } }) + "\\n");
  } else if (request.method === "authenticate") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  } else if (request.method === "_x.ai/interject") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid params", data: "session not found: xora-sidecar-smoke-missing-session" } }) + "\\n");
  }
});`);

  const result = spawnSync(process.execPath, [smokeScript, "--binary", binary], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ACP initialize, API-key auth, _x\.ai\/interject, process cleanup/u);
});

test("ACP smoke reports an early sidecar exit without waiting for request timeout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-sidecar-exit-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "fake-grok.mjs");
  await createFakeGrok(binary, `
if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.102 (exit fixture)\\n");
  process.exit(0);
}
process.exit(23);`);

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [smokeScript, "--binary", binary], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.ok(Date.now() - startedAt < 5_000, "early exit should fail promptly");
  assert.match(result.stderr, /code 23/u);
  assert.doesNotMatch(result.stderr, /initialize timed out/u);
});

test("release manifests use independent Ed25519 signatures and complete target metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-release-manifest-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, "assets");
  await createAssets(assets);
  const app = generateKeyPairSync("ed25519");
  const sidecar = generateKeyPairSync("ed25519");

  execFileSync(process.execPath, [
    signScript,
    "--assets-dir", assets,
    "--output-dir", assets,
    "--base-url", "https://github.com/WhiteNightShadow/xora-code/releases/download/v0.1.0",
    "--app-version", "0.1.0",
    "--sequence", "42",
    "--released-at", "2026-07-19T00:00:00.000Z",
  ], {
    env: {
      ...process.env,
      APP_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(app.privateKey),
      SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(sidecar.privateKey),
    },
    stdio: "pipe",
  });

  const appManifest = JSON.parse(await readFile(join(assets, "xora-code-update.json"), "utf8"));
  const sidecarManifest = JSON.parse(await readFile(join(assets, "grok-sidecar-update.json"), "utf8"));
  assert.equal(appManifest.payload.sequence, 42);
  assert.equal(sidecarManifest.payload.upstream.commit, "98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce");
  assert.equal(sidecarManifest.payload.patchSha256, "2737876ec3d0f38947566218a24d0c66d83d5d12311138aff45c586e0ab80d46");
  assert.deepEqual(sidecarManifest.payload.bundledTools.ripgrep, {
    package: "ripgrep",
    version: "15.0.0",
    source: "crates.io",
    features: ["pcre2"],
    lockedSourceBuild: true,
  });
  assert.deepEqual(Object.keys(sidecarManifest.payload.artifacts).sort(), [
    "darwin-arm64", "darwin-x64", "linux-x64", "win32-x64",
  ]);
  assert.match(sidecarManifest.payload.artifacts["win32-x64"].url, /win32-x64\.exe$/u);
  assert.doesNotMatch(sidecarManifest.payload.artifacts["linux-x64"].url, /\.tar\.gz$/u);
  assert.equal(
    verify(null, Buffer.from(canonical(appManifest.payload)), app.publicKey, Buffer.from(appManifest.signatures[0].signature, "base64")),
    true,
  );
  assert.equal(
    verify(null, Buffer.from(canonical(sidecarManifest.payload)), sidecar.publicKey, Buffer.from(sidecarManifest.signatures[0].signature, "base64")),
    true,
  );
  assert.equal(
    verify(null, Buffer.from(canonical(sidecarManifest.payload)), app.publicKey, Buffer.from(sidecarManifest.signatures[0].signature, "base64")),
    false,
  );
});

test("release manifest signer rejects reuse of one key pair", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-release-key-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createAssets(root);
  const key = generateKeyPairSync("ed25519");
  const result = spawnSync(process.execPath, [
    signScript,
    "--assets-dir", root,
    "--output-dir", root,
    "--base-url", "https://example.com/v0.1.0",
    "--app-version", "0.1.0",
    "--sequence", "1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(key.privateKey),
      SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(key.privateKey),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /independent Ed25519 keys/u);
});

test("release manifest signer rejects an executable suffix for the wrong platform", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-release-target-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createAssets(root);
  await writeFile(
    join(root, "Xora-Code-Grok-Build-0.2.102-linux-x64.exe"),
    "wrong platform fixture",
    "utf8",
  );
  const app = generateKeyPairSync("ed25519");
  const sidecar = generateKeyPairSync("ed25519");
  const result = spawnSync(process.execPath, [
    signScript,
    "--assets-dir", root,
    "--output-dir", root,
    "--base-url", "https://example.com/v0.1.0",
    "--app-version", "0.1.0",
    "--sequence", "1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(app.privateKey),
      SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(sidecar.privateKey),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be named/u);
});

test("release collector rejects duplicate basenames instead of overwriting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-release-collect-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "input/a"), { recursive: true });
  await mkdir(join(root, "input/b"), { recursive: true });
  await writeFile(join(root, "input/a/same.zip"), "one", "utf8");
  await writeFile(join(root, "input/b/same.zip"), "two", "utf8");
  const result = spawnSync(process.execPath, [
    collectScript,
    "--input", join(root, "input"),
    "--output", join(root, "output"),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate release artifact name/u);
});

test("release key gate requires a committed public key matching an independent private key", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "xora-release-trust-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = generateKeyPairSync("ed25519");
  const sidecar = generateKeyPairSync("ed25519");
  const sidecarSpki = sidecar.publicKey.export({ format: "der", type: "spki" });
  const config = join(root, "trusted.json");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    keys: [{
      keyId: "sidecar-release-2026",
      algorithm: "ed25519",
      publicKey: sidecarSpki.subarray(-32).toString("base64"),
    }],
  })}\n`, "utf8");
  const result = spawnSync(process.execPath, [verifyKeysScript, "--config", config], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(app.privateKey),
      SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64: encodedPrivateKey(sidecar.privateKey),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified committed sidecar trust anchor/u);
});
