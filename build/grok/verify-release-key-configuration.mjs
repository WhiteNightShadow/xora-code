#!/usr/bin/env node
// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rawEd25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

function fail(message) {
  throw new Error(`Release key configuration refused: ${message}`);
}

function privateKey(name) {
  const encoded = process.env[name];
  if (!encoded) fail(`${name} is missing`);
  const bytes = Buffer.from(encoded, "base64");
  const key = bytes.includes(Buffer.from("BEGIN PRIVATE KEY"))
    ? createPrivateKey(bytes)
    : createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") fail(`${name} is not Ed25519`);
  return key;
}

function configuredPublicKey(value) {
  if (typeof value !== "string" || value.length === 0) fail("trusted publicKey is missing");
  if (value.includes("BEGIN PUBLIC KEY")) return createPublicKey(value);
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 32) fail("trusted publicKey must be PEM or raw 32-byte base64");
  return createPublicKey({ key: Buffer.concat([rawEd25519SpkiPrefix, raw]), format: "der", type: "spki" });
}

function fingerprint(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

const appPrivateKey = privateKey("APP_UPDATE_ED25519_PRIVATE_KEY_BASE64");
const sidecarPrivateKey = privateKey("SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64");
if (fingerprint(appPrivateKey) === fingerprint(sidecarPrivateKey)) {
  fail("application and sidecar update keys must be independent");
}

const configIndex = process.argv.indexOf("--config");
const configurationPath = configIndex >= 0 && process.argv[configIndex + 1]
  ? resolve(process.argv[configIndex + 1])
  : join(repositoryRoot, "resources/update/sidecar-trusted-keys.json");
const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
if (configuration.schemaVersion !== 1 || !Array.isArray(configuration.keys) || configuration.keys.length === 0) {
  fail("resources/update/sidecar-trusted-keys.json must contain at least one committed public key");
}
const keyId = process.env.SIDECAR_UPDATE_KEY_ID ?? "sidecar-release-2026";
const trusted = configuration.keys.find((candidate) => candidate?.keyId === keyId);
if (!trusted || trusted.algorithm !== "ed25519" || trusted.revoked === true) {
  fail(`active committed sidecar public key ${keyId} was not found`);
}
const now = Date.now();
if (trusted.notBefore && Date.parse(trusted.notBefore) > now) fail(`${keyId} is not active yet`);
if (trusted.notAfter && Date.parse(trusted.notAfter) < now) fail(`${keyId} has expired`);
if (fingerprint(configuredPublicKey(trusted.publicKey)) !== fingerprint(sidecarPrivateKey)) {
  fail(`${keyId} does not match SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64`);
}
process.stdout.write(`Verified committed sidecar trust anchor ${keyId} and independent release keys.\n`);
