#!/usr/bin/env node
// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const lockPath = join(scriptDirectory, "sidecar.lock.json");
const fixturePath = join(scriptDirectory, "acp-initialize-fixture.json");
const emptySha256 = createHash("sha256").update("").digest("hex");

function fail(message) {
  throw new Error(`Release manifest signing refused: ${message}`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) fail(`invalid argument ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  for (const required of ["assets-dir", "output-dir", "base-url", "app-version", "sequence"]) {
    if (!values[required]) fail(`--${required} is required`);
  }
  const sequence = Number(values.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail("--sequence must be a positive safe integer");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(values["app-version"])) {
    fail("--app-version must be SemVer without a leading v");
  }
  const baseUrl = new URL(values["base-url"]);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.hash) {
    fail("--base-url must be a credential-free HTTPS URL");
  }
  return {
    assetsDirectory: resolve(values["assets-dir"]),
    outputDirectory: resolve(values["output-dir"]),
    baseUrl: baseUrl.href.replace(/\/$/u, ""),
    appVersion: values["app-version"],
    sequence,
    releasedAt: values["released-at"] ?? new Date().toISOString(),
  };
}

function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${path} contains an unpaired high surrogate`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${path} contains an unpaired low surrogate`);
    }
  }
}

function canonicalize(value, path = "$", ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) fail(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors)).join(",")}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertUnicodeScalarString(key, `${path} key`);
        return `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function privateKeyFromEnvironment(name) {
  const encoded = process.env[name];
  if (!encoded) fail(`${name} is required`);
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64");
  } catch {
    fail(`${name} must be base64-encoded PEM or PKCS#8 DER`);
  }
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/u, "") !== encoded.replace(/\s+/gu, "").replace(/=+$/u, "")) {
    fail(`${name} must use canonical base64 encoding`);
  }
  const key = decoded.includes(Buffer.from("BEGIN PRIVATE KEY"))
    ? createPrivateKey(decoded)
    : createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") fail(`${name} is not an Ed25519 private key`);
  return key;
}

function publicFingerprint(key) {
  return createHash("sha256")
    .update(createPublicKey(key).export({ format: "der", type: "spki" }))
    .digest("hex");
}

function signed(payload, privateKey, keyId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(keyId)) fail(`invalid key id ${keyId}`);
  const signature = sign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64");
  return { payload, signatures: [{ keyId, algorithm: "ed25519", signature }] };
}

async function filesBelow(root, directory = root) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(root, path)));
    else if (entry.isFile()) output.push({ path, name: relative(root, path).replaceAll("\\", "/") });
  }
  return output;
}

function sidecarTarget(name, version) {
  const prefix = `Xora-Code-Grok-Build-${version}-`;
  if (!name.startsWith(prefix)) return undefined;
  if (name.endsWith(".tar.gz") || name.endsWith(".zip")) return undefined;
  const suffix = name.endsWith(".exe") ? ".exe" : "";
  return name.slice(prefix.length, name.length - suffix.length);
}

function appTarget(name) {
  if (!name.startsWith("Xora Code-")) return undefined;
  if (name.endsWith(".dmg") || name.endsWith(".zip")) {
    if (name.includes("arm64")) return "darwin-arm64";
    if (name.includes("x64")) return "darwin-x64";
  }
  if (name.endsWith(".exe")) return "win32-x64";
  if (name.endsWith(".AppImage") || name.endsWith(".deb")) return "linux-x64";
  return undefined;
}

async function artifact(path, name, baseUrl) {
  const bytes = await readFile(path);
  const fileStat = await stat(path);
  return {
    url: `${baseUrl}/${encodeURIComponent(basename(name))}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: fileStat.size,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const lockBytes = await readFile(lockPath);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const fixtureBytes = await readFile(fixturePath);
  const files = await filesBelow(options.assetsDirectory);
  const sidecarArtifacts = {};
  const appArtifacts = {};

  for (const file of files) {
    const sidecar = sidecarTarget(basename(file.name), lock.upstream.version);
    if (sidecar) {
      if (!lock.targets[sidecar]) fail(`sidecar archive names unknown target ${sidecar}`);
      const expectedName = `Xora-Code-Grok-Build-${lock.upstream.version}-${sidecar}${lock.targets[sidecar].executableSuffix}`;
      if (basename(file.name) !== expectedName) {
        fail(`raw sidecar executable for ${sidecar} must be named ${expectedName}`);
      }
      if (sidecarArtifacts[sidecar]) fail(`multiple raw sidecar executables claim target ${sidecar}`);
      sidecarArtifacts[sidecar] = await artifact(file.path, file.name, options.baseUrl);
      continue;
    }
    const app = appTarget(basename(file.name));
    if (app) {
      const value = await artifact(file.path, file.name, options.baseUrl);
      appArtifacts[basename(file.name)] = { ...value, target: app };
    }
  }

  for (const required of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) {
    if (!sidecarArtifacts[required]) fail(`missing raw signed sidecar executable for ${required}`);
  }
  const appTargets = new Set(Object.values(appArtifacts).map((value) => value.target));
  for (const required of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) {
    if (!appTargets.has(required)) fail(`missing desktop application artifact for ${required}`);
  }

  const appKey = privateKeyFromEnvironment("APP_UPDATE_ED25519_PRIVATE_KEY_BASE64");
  const sidecarKey = privateKeyFromEnvironment("SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64");
  if (publicFingerprint(appKey) === publicFingerprint(sidecarKey)) {
    fail("application and sidecar manifests must use independent Ed25519 keys");
  }

  const appPayload = {
    schemaVersion: 1,
    product: "xora-code",
    sequence: options.sequence,
    channel: "stable",
    version: options.appVersion,
    releasedAt: options.releasedAt,
    artifacts: appArtifacts,
  };
  const sidecarPayload = {
    schemaVersion: 1,
    product: "xora-grok-sidecar",
    sequence: options.sequence,
    channel: "stable",
    version: lock.upstream.version,
    releasedAt: options.releasedAt,
    homeCompatEpoch: 1,
    patchSha256: emptySha256,
    appCompatibility: {
      minimumVersion: options.appVersion,
      maximumVersion: options.appVersion,
    },
    sidecarLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    upstream: {
      commit: lock.upstream.commit,
      sourceRevision: lock.upstream.sourceRevision,
    },
    bundledTools: {
      ripgrep: {
        package: lock.bundledTools.ripgrep.package,
        version: lock.bundledTools.ripgrep.version,
        source: lock.bundledTools.ripgrep.source,
        features: lock.bundledTools.ripgrep.features,
        lockedSourceBuild: true,
      },
    },
    acp: {
      transport: lock.runtime.transport,
      command: lock.runtime.args,
      fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
    },
    artifacts: sidecarArtifacts,
  };

  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(
    join(options.outputDirectory, "xora-code-update.json"),
    `${JSON.stringify(signed(appPayload, appKey, process.env.APP_UPDATE_KEY_ID ?? "app-release-2026"), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(
    join(options.outputDirectory, "grok-sidecar-update.json"),
    `${JSON.stringify(signed(sidecarPayload, sidecarKey, process.env.SIDECAR_UPDATE_KEY_ID ?? "sidecar-release-2026"), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(`Signed independent application and sidecar manifests at sequence ${options.sequence}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
