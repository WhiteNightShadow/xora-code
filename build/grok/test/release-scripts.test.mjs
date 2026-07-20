import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  }
});`);

  const result = spawnSync(process.execPath, [smokeScript, "--binary", binary], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ACP initialize, API-key auth, process cleanup/u);
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
