#!/usr/bin/env node
// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const lockPath = path.join(scriptDirectory, "syft.lock.json");
const DEFAULT_OUTPUT_DIRECTORY = path.join(repositoryRoot, "applications", "electron", "dist", "preview-assets");
const MAX_EXTRACTED_BINARY_BYTES = 512 * 1024 * 1024;

function fail(message) {
  throw new Error(`Pinned Syft SBOM generation refused: ${message}`);
}

export function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["target", "cache-dir", "output-dir", "source-dir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || !allowed.has(name.slice(2))) fail(`unknown argument ${name}`);
    if (Object.hasOwn(values, name.slice(2))) fail(`duplicate argument ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    values[name.slice(2)] = value;
  }
  if (!values.target) fail("--target is required");
  if (!values["cache-dir"]) fail("--cache-dir is required");
  if (!values["source-dir"]) fail("--source-dir must point to the unpacked packaged application");
  return {
    target: values.target,
    cacheDirectory: path.resolve(values["cache-dir"]),
    outputDirectory: path.resolve(values["output-dir"] ?? DEFAULT_OUTPUT_DIRECTORY),
    sourceDirectory: path.resolve(values["source-dir"])
  };
}

export function loadLock(file = lockPath) {
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  if (lock.schemaVersion !== 1 || lock.tool !== "syft" || !/^\d+\.\d+\.\d+$/u.test(lock.version)) {
    fail("invalid syft.lock.json header");
  }
  if (!Number.isSafeInteger(lock.maximumArchiveBytes) || lock.maximumArchiveBytes <= 0) {
    fail("invalid maximumArchiveBytes");
  }
  for (const [target, asset] of Object.entries(lock.targets ?? {})) {
    if (!/^(?:darwin-(?:arm64|x64)|linux-x64|win32-x64)$/u.test(target)) fail(`unsupported locked target ${target}`);
    const url = new URL(asset.url);
    if (url.protocol !== "https:" || url.hostname !== "github.com" ||
        !url.pathname.startsWith(`/anchore/syft/releases/download/v${lock.version}/`)) {
      fail(`untrusted URL for ${target}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256) || !["tar.gz", "zip"].includes(asset.archive)) {
      fail(`invalid locked asset for ${target}`);
    }
    if (path.basename(asset.fileName) !== asset.fileName || path.basename(asset.binary) !== asset.binary) {
      fail(`unsafe locked file name for ${target}`);
    }
  }
  return lock;
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    fail("archive contains an invalid path");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) fail("archive contains an absolute path");
  const segments = value.split("/");
  if (segments.some(segment => segment === "..")) fail("archive path traversal detected");
  const normalized = path.posix.normalize(value).replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) fail("archive contains an unsafe path");
  return normalized;
}

function parseTarNumber(bytes, label) {
  const text = bytes.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]*$/u.test(text)) fail(`invalid tar ${label}`);
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid tar ${label}`);
  return value;
}

function tarHeaderChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  return sum;
}

function tarString(bytes) {
  const zero = bytes.indexOf(0);
  return bytes.subarray(0, zero < 0 ? bytes.length : zero).toString("utf8");
}

function parsePax(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) fail("malformed tar PAX record");
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) fail("malformed tar PAX length");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("malformed tar PAX field");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

export function extractTarGzipBinary(archive, destination, expectedName) {
  const data = gunzipSync(fs.readFileSync(archive), { maxOutputLength: MAX_EXTRACTED_BINARY_BYTES * 2 });
  let offset = 0;
  let extracted;
  let nextPath;
  let pax = {};
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const expectedChecksum = parseTarNumber(header.subarray(148, 156), "checksum");
    if (expectedChecksum !== tarHeaderChecksum(header)) fail("tar header checksum mismatch");
    const size = parseTarNumber(header.subarray(124, 136), "size");
    if (size > MAX_EXTRACTED_BINARY_BYTES || offset + 512 + size > data.length) fail("tar entry is too large or truncated");
    const prefix = tarString(header.subarray(345, 500));
    const headerName = tarString(header.subarray(0, 100));
    const rawName = pax.path ?? nextPath ?? (prefix ? `${prefix}/${headerName}` : headerName);
    const type = String.fromCharCode(header[156] || 48);
    const body = data.subarray(offset + 512, offset + 512 + size);
    if (type === "x" || type === "g") {
      safeArchivePath(prefix ? `${prefix}/${headerName}` : headerName);
      const parsed = parsePax(body);
      if (parsed.path) safeArchivePath(parsed.path);
      if (parsed.linkpath) fail("tar links are not allowed");
      pax = type === "g" ? { ...pax, ...parsed } : parsed;
    } else if (type === "L") {
      safeArchivePath(prefix ? `${prefix}/${headerName}` : headerName);
      nextPath = tarString(body);
      safeArchivePath(nextPath);
    } else {
      const name = safeArchivePath(rawName);
      if (pax.linkpath) fail("tar links are not allowed");
      if (type === "1" || type === "2") fail("tar links are not allowed");
      if (!["0", "5"].includes(type)) fail(`unsupported tar entry type ${type}`);
      if (type === "0" && name === expectedName) {
        if (extracted) fail(`archive contains duplicate ${expectedName}`);
        fs.writeFileSync(destination, body, { flag: "wx", mode: 0o755 });
        extracted = destination;
      }
      pax = {};
      nextPath = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!extracted) fail(`archive does not contain ${expectedName}`);
  if (process.platform !== "win32") fs.chmodSync(extracted, 0o755);
  return extracted;
}

function findZipEndOfCentralDirectory(data) {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail("zip end-of-central-directory record is missing");
}

export function extractZipBinary(archive, destination, expectedName) {
  const data = fs.readFileSync(archive);
  const eocd = findZipEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const entries = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail("multi-disk and ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > eocd) fail("zip central directory is truncated");
  const seen = new Set();
  let extracted;
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) fail("malformed zip central directory");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const externalAttributes = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    if ((flags & 1) !== 0) fail("encrypted zip entries are not allowed");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || uncompressedSize > MAX_EXTRACTED_BINARY_BYTES) {
      fail("ZIP64 or oversized zip entry is not supported");
    }
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const name = safeArchivePath(rawName);
    if (seen.has(name)) fail(`archive contains duplicate path ${name}`);
    seen.add(name);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) fail("zip links are not allowed");
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) fail("malformed zip local header");
    if (data.readUInt16LE(localOffset + 6) !== flags || data.readUInt16LE(localOffset + 8) !== method) {
      fail("zip local and central metadata differ");
    }
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localName = data.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (safeArchivePath(localName) !== name) fail("zip local and central paths differ");
    const bodyOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (bodyOffset + compressedSize > data.length) fail("zip entry is truncated");
    if (name === expectedName) {
      if (extracted) fail(`archive contains duplicate ${expectedName}`);
      const compressed = data.subarray(bodyOffset, bodyOffset + compressedSize);
      const contents = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_EXTRACTED_BINARY_BYTES }) : undefined;
      if (!contents) fail(`unsupported zip compression method ${method}`);
      if (contents.length !== uncompressedSize) fail("zip entry size mismatch");
      fs.writeFileSync(destination, contents, { flag: "wx", mode: 0o755 });
      extracted = destination;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!extracted) fail(`archive does not contain ${expectedName}`);
  return extracted;
}

async function downloadVerifiedAsset(asset, cacheDirectory, maximumBytes, fetchImpl = fetch) {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const archive = path.join(cacheDirectory, asset.fileName);
  if (fs.existsSync(archive) && sha256File(archive) === asset.sha256) return archive;
  if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
  const temporary = `${archive}.part-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const response = await fetchImpl(asset.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) fail(`download failed with HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maximumBytes) fail("download exceeds maximumArchiveBytes");
    let received = 0;
    const limiter = new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maximumBytes) throw new Error("download exceeds maximumArchiveBytes");
        controller.enqueue(chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body.pipeThrough(limiter)), fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const actual = sha256File(temporary);
    if (actual !== asset.sha256) fail(`archive SHA-256 mismatch: expected ${asset.sha256}, received ${actual}`);
    fs.renameSync(temporary, archive);
    return archive;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function verifySyftVersion(binary, expectedVersion, spawn = spawnSync) {
  const result = spawn(binary, ["version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000
  });
  if (result.error || result.status !== 0) fail(`syft version failed with status ${result.status ?? "unknown"}`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/^Application:\s*syft\s*$/imu.test(output) || !new RegExp(`^Version:\\s*v?${expectedVersion.replaceAll(".", "\\.")}\\s*$`, "imu").test(output)) {
    fail(`expected Syft ${expectedVersion}, received an incompatible binary`);
  }
}

export function runSyft(binary, sourceDirectory, sbomPath, spawn = spawnSync, exclusions = []) {
  for (const exclusion of exclusions) {
    if (typeof exclusion !== "string" || !/^\.\/[A-Za-z0-9*?._/-]+$/u.test(exclusion) || exclusion.includes("..")) {
      fail("invalid Syft exclusion pattern");
    }
  }
  const environment = { ...process.env, SYFT_CHECK_FOR_APP_UPDATE: "false" };
  const exclusionArguments = exclusions.flatMap(exclusion => ["--exclude", exclusion]);
  const result = spawn(binary, ["dir:.", ...exclusionArguments, "-o", `cyclonedx-json=${sbomPath}`], {
    cwd: sourceDirectory,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10 * 60_000
  });
  if (result.error || result.status !== 0) fail(`syft scan failed with status ${result.status ?? "unknown"}`);
  if (!fs.existsSync(sbomPath) || !fs.statSync(sbomPath).isFile()) fail("syft did not produce the requested SBOM");
  const document = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
  if (document.bomFormat !== "CycloneDX" || typeof document.specVersion !== "string") fail("syft produced an invalid CycloneDX document");
}

function mergeByIdentity(values) {
  const merged = new Map();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const identity = typeof value["bom-ref"] === "string" ? `ref:${value["bom-ref"]}`
      : typeof value.purl === "string" ? `purl:${value.purl}`
        : `json:${JSON.stringify(value)}`;
    if (!merged.has(identity)) merged.set(identity, value);
  }
  return [...merged.values()];
}

export function mergeCycloneDxDocuments(packaged, dependencyInventory) {
  if (packaged?.bomFormat !== "CycloneDX" || dependencyInventory?.bomFormat !== "CycloneDX"
    || packaged.specVersion !== dependencyInventory.specVersion) {
    fail("Syft produced incompatible CycloneDX documents");
  }
  const dependencyMap = new Map();
  for (const dependency of [...(packaged.dependencies ?? []), ...(dependencyInventory.dependencies ?? [])]) {
    if (!dependency || typeof dependency.ref !== "string") continue;
    const current = dependencyMap.get(dependency.ref) ?? new Set();
    for (const reference of dependency.dependsOn ?? []) {
      if (typeof reference === "string") current.add(reference);
    }
    dependencyMap.set(dependency.ref, current);
  }
  const toolComponents = mergeByIdentity([
    ...(packaged.metadata?.tools?.components ?? []),
    ...(dependencyInventory.metadata?.tools?.components ?? [])
  ]);
  return {
    ...packaged,
    metadata: {
      ...(packaged.metadata ?? {}),
      tools: { components: toolComponents },
      properties: [
        ...((packaged.metadata?.properties ?? []).filter(property => property?.name !== "xora:inventory-scope")),
        { name: "xora:inventory-scope", value: "packaged-payload-plus-locked-build-dependencies" }
      ]
    },
    components: mergeByIdentity([...(packaged.components ?? []), ...(dependencyInventory.components ?? [])]),
    ...(dependencyMap.size ? {
      dependencies: [...dependencyMap.entries()].map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    } : {})
  };
}

export function normalizeProductComponent(document, { name, packageName, version }) {
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const debPurl = new RegExp(`^pkg:deb/${escapedPackage}@${version.replaceAll(".", "\\.")}(?:\\?|$)`, "u");
  const matches = (document.components ?? []).filter(component =>
    component?.name === packageName && component?.version === version && debPurl.test(component?.purl ?? ""));
  if (matches.length > 1) fail(`multiple ${packageName} product components were discovered`);
  if (matches.length === 1) matches[0].name = name;
  return document;
}

/**
 * Refuse to call a source-tree inventory a distribution SBOM. The scan root
 * must be electron-builder's unpacked application and must contain both the
 * ASAR application and the exact sidecar/legal resources shipped to users.
 */
export function validatePackagedApplicationRoot(sourceDirectory, target) {
  const source = path.resolve(sourceDirectory);
  let resources;
  if (target.startsWith("darwin-")) {
    const applications = fs.readdirSync(source, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.endsWith(".app"));
    if (applications.length !== 1) fail(`expected one packaged macOS application, found ${applications.length}`);
    resources = path.join(source, applications[0].name, "Contents", "Resources");
  } else {
    resources = path.join(source, "resources");
  }
  const executable = target === "win32-x64" ? "grok.exe" : "grok";
  const required = [
    path.join(resources, "app.asar"),
    path.join(resources, "sidecars", "grok", executable),
    path.join(resources, "sidecars", "grok", "release.json"),
    path.join(resources, "legal", "THIRD-PARTY-NOTICES.md"),
    path.join(resources, "legal", "dependencies", "LEGAL-INVENTORY.json")
  ];
  for (const file of required) {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      fail(`packaged SBOM input is missing ${path.relative(source, file)}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`packaged SBOM input has an unsafe ${path.relative(source, file)}`);
    }
  }
  return source;
}

export function sanitizeSbomBuildPaths(sbomPath, sourceDirectory) {
  const document = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
  const roots = new Set();
  const sourceDirectories = Array.isArray(sourceDirectory) ? sourceDirectory : [sourceDirectory];
  for (const directory of sourceDirectories) {
    for (const root of [path.resolve(directory), fs.realpathSync(directory)]) {
      roots.add(root);
      roots.add(root.replaceAll("\\", "/"));
      roots.add(root.replaceAll("/", "\\"));
    }
  }
  const ordered = [...roots].filter(Boolean).sort((left, right) => right.length - left.length);
  const rewrite = value => {
    if (typeof value === "string") {
      let result = value;
      for (const root of ordered) result = result.replaceAll(root, "");
      return result;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
    }
    return value;
  };
  const sanitized = rewrite(document);
  const serialized = `${JSON.stringify(sanitized)}\n`;
  for (const root of ordered) {
    if (serialized.includes(root)) fail("SBOM contains the native build root after sanitization");
  }
  fs.writeFileSync(sbomPath, serialized, { mode: 0o644 });
}

export function addSbomChecksum(checksumPath, sbomPath) {
  const sbomName = path.basename(sbomPath);
  if (sbomName !== path.basename(sbomPath) || !/^[A-Za-z0-9._-]+\.cdx\.json$/u.test(sbomName)) fail("unsafe SBOM file name");
  const lines = fs.readFileSync(checksumPath, "utf8").split(/\r?\n/u).filter(Boolean);
  const records = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9 ._()+-]*)$/u.exec(line);
    if (!match) fail(`malformed checksum line in ${path.basename(checksumPath)}`);
    const [, digest, name] = match;
    if (name !== sbomName && records.has(name)) fail(`duplicate checksum entry ${name}`);
    if (name !== sbomName) records.set(name, digest);
  }
  records.set(sbomName, sha256File(sbomPath));
  const contents = [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n");
  const temporary = `${checksumPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${contents}\n`, { flag: "wx", mode: 0o644 });
    fs.renameSync(temporary, checksumPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function generatePreviewSbom(options, dependencies = {}) {
  const lock = loadLock(dependencies.lockPath ?? lockPath);
  const asset = lock.targets[options.target];
  if (!asset) fail(`target ${options.target} is not locked`);
  const archive = await downloadVerifiedAsset(asset, options.cacheDirectory, lock.maximumArchiveBytes, dependencies.fetchImpl);
  const toolDirectory = path.join(options.cacheDirectory, `syft-${lock.version}-${options.target}`);
  fs.rmSync(toolDirectory, { recursive: true, force: true });
  fs.mkdirSync(toolDirectory, { recursive: true, mode: 0o700 });
  const binary = path.join(toolDirectory, asset.binary);
  if (asset.archive === "tar.gz") extractTarGzipBinary(archive, binary, asset.binary);
  else extractZipBinary(archive, binary, asset.binary);
  verifySyftVersion(binary, lock.version, dependencies.spawnImpl);

  const packagedSource = validatePackagedApplicationRoot(options.sourceDirectory, options.target);

  const applicationPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const sbomPath = path.join(options.outputDirectory, `Xora-Code-${applicationPackage.version}-${options.target}.cdx.json`);
  const checksumPath = path.join(options.outputDirectory, `SHA256SUMS-${options.target}.txt`);
  if (!fs.existsSync(checksumPath)) fail(`missing ${path.basename(checksumPath)}; package the native preview first`);
  fs.rmSync(sbomPath, { force: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(options.cacheDirectory, ".xora-sbom-work-"));
  try {
    const packagedSbomPath = path.join(temporaryDirectory, "packaged.cdx.json");
    const dependencySbomPath = path.join(temporaryDirectory, "dependencies.cdx.json");
    runSyft(binary, packagedSource, packagedSbomPath, dependencies.spawnImpl);
    // Electron ASAR and stripped Rust binaries are not fully catalogued by
    // Syft 1.48.0. Merge the verified payload scan with a conservative scan of
    // the exact committed dependency tree used to produce it, instead of
    // publishing a deceptively tiny payload-only inventory.
    // The dependency inventory must not recursively catalog the installers
    // that were just produced under dist/. Besides double-counting the product,
    // Linux Syft gives the AppImage and deb discoveries distinct bom-refs for
    // one package. The unpacked payload is already scanned independently above.
    runSyft(binary, repositoryRoot, dependencySbomPath, dependencies.spawnImpl, [
      "./applications/electron/dist/**"
    ]);
    const merged = normalizeProductComponent(mergeCycloneDxDocuments(
      JSON.parse(fs.readFileSync(packagedSbomPath, "utf8")),
      JSON.parse(fs.readFileSync(dependencySbomPath, "utf8"))
    ), {
      name: applicationPackage.productName ?? "Xora Code",
      packageName: "xora-code",
      version: applicationPackage.version
    });
    fs.writeFileSync(sbomPath, `${JSON.stringify(merged)}\n`, { flag: "wx", mode: 0o644 });
    sanitizeSbomBuildPaths(sbomPath, [packagedSource, repositoryRoot]);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  addSbomChecksum(checksumPath, sbomPath);
  return { binary, sbomPath, checksumPath };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const result = await generatePreviewSbom(parseArguments(process.argv.slice(2)));
    process.stdout.write(`Generated pinned CycloneDX SBOM: ${result.sbomPath}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
