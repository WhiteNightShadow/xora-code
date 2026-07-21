#!/usr/bin/env node
// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

const TARGETS = Object.freeze({
  "darwin-arm64": version => [`Xora Code-${version}-mac-arm64.dmg`, `Xora Code-${version}-mac-arm64.zip`],
  "darwin-x64": version => [`Xora Code-${version}-mac-x64.dmg`, `Xora Code-${version}-mac-x64.zip`],
  "linux-x64": version => [`Xora Code-${version}-linux-x86_64.AppImage`, `Xora Code-${version}-linux-amd64.deb`],
  "win32-x64": version => [`Xora Code-${version}-win-x64.exe`],
});

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]*$/u;
const FORBIDDEN_ASSET = /(?:app-update\.json|grok-sidecar-update\.json|SHA256SUMS\.asc|\.(?:asc|sig))$/iu;

function fail(message) {
  throw new Error(`Native preview asset verification refused: ${message}`);
}

export function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["target", "commit", "assets-dir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") || !allowed.has(argument.slice(2))) fail(`unknown argument ${argument}`);
    const name = argument.slice(2);
    if (Object.hasOwn(values, name)) fail(`duplicate argument ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    values[name] = value;
  }
  if (!TARGETS[values.target]) fail(`unsupported target ${values.target ?? "(missing)"}`);
  if (!/^[0-9a-f]{40}$/u.test(values.commit ?? "")) fail("--commit must be a full lowercase Git SHA");
  if (!values["assets-dir"]) fail("--assets-dir is required");
  return {
    target: values.target,
    commit: values.commit,
    assetsDirectory: path.resolve(values["assets-dir"]),
  };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertRegularFile(file, label) {
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    fail(`${label} is not a non-empty regular file`);
  }
}

function loadJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function verifyPreviewAssets({ target, commit, assetsDirectory }) {
  const expectedInstallers = TARGETS[target];
  if (!expectedInstallers || !/^[0-9a-f]{40}$/u.test(commit)) fail("invalid verification inputs");
  const directory = fs.lstatSync(assetsDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail("assets directory is not a real directory");

  const entries = fs.readdirSync(assetsDirectory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) fail("preview assets must be a flat set of regular files");
  const names = entries.map(entry => entry.name).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    if (!SAFE_ASSET_NAME.test(name) || path.basename(name) !== name) fail(`unsafe asset name ${JSON.stringify(name)}`);
    if (FORBIDDEN_ASSET.test(name)) fail(`formal-release signature or update manifest appeared in preview assets: ${name}`);
    assertRegularFile(path.join(assetsDirectory, name), name);
  }

  const packageJson = loadJson(path.join(repositoryRoot, "package.json"), "root package.json");
  const version = packageJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    fail("root package.json has an invalid version");
  }
  const installerNames = expectedInstallers(version);
  const checksumName = `SHA256SUMS-${target}.txt`;
  const provenanceName = `Xora-Code-${version}-${target}-PREVIEW.json`;
  const sbomName = `Xora-Code-${version}-${target}.cdx.json`;
  for (const required of [...installerNames, checksumName, provenanceName, sbomName]) {
    if (!names.includes(required)) fail(`missing ${required}`);
  }
  const allowedNames = new Set([
    ...installerNames,
    ...installerNames.map(name => `${name}.blockmap`),
    checksumName,
    provenanceName,
    sbomName,
  ]);
  const unexpectedNames = names.filter(name => !allowedNames.has(name));
  if (unexpectedNames.length) fail(`unexpected preview assets: ${unexpectedNames.join(", ")}`);

  const checksumLines = fs.readFileSync(path.join(assetsDirectory, checksumName), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean);
  const referenced = new Map();
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9 ._()+-]*)$/u.exec(line);
    if (!match) fail(`malformed checksum line in ${checksumName}`);
    const [, expectedDigest, name] = match;
    if (name === checksumName || referenced.has(name) || !names.includes(name)) {
      fail(`invalid or duplicate checksum reference ${name}`);
    }
    const actualDigest = sha256(path.join(assetsDirectory, name));
    if (actualDigest !== expectedDigest) fail(`checksum mismatch for ${name}`);
    referenced.set(name, expectedDigest);
  }

  const expectedReferences = names.filter(name => name !== checksumName);
  const missingReferences = expectedReferences.filter(name => !referenced.has(name));
  if (missingReferences.length) fail(`assets are not checksummed: ${missingReferences.join(", ")}`);
  if (referenced.size !== expectedReferences.length) fail("checksum set references an unexpected asset");

  const provenance = loadJson(path.join(assetsDirectory, provenanceName), provenanceName);
  if (
    provenance.schemaVersion !== 1 ||
    provenance.product !== "xora-code" ||
    provenance.version !== version ||
    provenance.target !== target ||
    provenance.commit !== commit ||
    provenance.preview !== true ||
    provenance.productionSigned !== false
  ) {
    fail(`invalid preview provenance in ${provenanceName}`);
  }

  const sbom = loadJson(path.join(assetsDirectory, sbomName), sbomName);
  const inventoryScope = sbom.metadata?.properties?.find(property =>
    property?.name === "xora:inventory-scope")?.value;
  if (
    sbom.bomFormat !== "CycloneDX" ||
    typeof sbom.specVersion !== "string" ||
    !Array.isArray(sbom.components) ||
    sbom.components.length === 0 ||
    inventoryScope !== "packaged-payload-plus-locked-build-dependencies" ||
    !sbom.components.some(component => component?.name === "Xora Code") ||
    !sbom.components.some(component => typeof component?.purl === "string" && component.purl.startsWith("pkg:npm/"))
  ) {
    fail(`invalid CycloneDX SBOM in ${sbomName}`);
  }

  return {
    target,
    commit,
    version,
    files: names,
    checksums: Object.fromEntries(referenced),
    sbomComponents: sbom.components.length,
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const result = verifyPreviewAssets(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
