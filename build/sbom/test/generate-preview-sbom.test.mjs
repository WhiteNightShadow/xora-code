// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  addSbomChecksum,
  extractTarGzipBinary,
  extractZipBinary,
  generatePreviewSbom,
  loadLock,
  mergeCycloneDxDocuments,
  normalizeProductComponent,
  parseArguments,
  runSyft,
  sanitizeSbomBuildPaths,
  validatePackagedApplicationRoot,
  verifySyftVersion
} from "../generate-preview-sbom.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sbomRoot = path.resolve(directory, "..");
const applicationVersion = JSON.parse(fs.readFileSync(path.resolve(sbomRoot, "..", "..", "package.json"), "utf8")).version;

function temporary(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function octal(value, bytes) {
  return `${value.toString(8).padStart(bytes - 2, "0")}\0 `;
}

function tarEntry(name, contents = Buffer.alloc(0), type = "0", linkName = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(octal(contents.length, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(octal(checksum, 8), 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function tarGzip(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const local = Buffer.alloc(30 + name.length + contents.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    contents.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, central, end]);
}

test("lock pins every native Syft 1.48.0 asset by official URL and SHA-256", () => {
  const lock = loadLock(path.join(sbomRoot, "syft.lock.json"));
  assert.equal(lock.version, "1.48.0");
  assert.deepEqual(Object.keys(lock.targets).sort(), ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
  assert.deepEqual(Object.fromEntries(Object.entries(lock.targets).map(([target, asset]) => [target, asset.sha256])), {
    "darwin-arm64": "fef3e6d5df336a0a4c3e421e503119d1e221cf82a3ef5e426a791fcd81667e87",
    "darwin-x64": "dc7b2135fa5591003596df4ddb3408f499b68174f5e7dc1c77a373b753463182",
    "linux-x64": "6cef9a7f37220d9067eaf9cfaaa2fce986e9f320a8d42cbc36658c99af78ea04",
    "win32-x64": "b46cb02a47c5b76a1656958757d62ac07d0cb7de35f92e8a7e02d450cbb53097"
  });
  for (const asset of Object.values(lock.targets)) {
    assert.match(asset.url, /^https:\/\/github\.com\/anchore\/syft\/releases\/download\/v1\.48\.0\//u);
  }
});

test("argument parser requires an allow-listed target and an explicit cache", () => {
  assert.throws(() => parseArguments(["--target", "linux-x64"]), /--cache-dir is required/u);
  assert.throws(
    () => parseArguments(["--target", "linux-x64", "--cache-dir", ".cache"]),
    /--source-dir must point to the unpacked packaged application/u,
  );
  assert.throws(() => parseArguments(["--wat", "value"]), /unknown argument/u);
  const parsed = parseArguments([
    "--target", "linux-x64", "--cache-dir", ".cache", "--source-dir", "applications/electron/dist/linux-unpacked",
  ]);
  assert.equal(parsed.target, "linux-x64");
  assert.equal(parsed.cacheDirectory, path.resolve(".cache"));
});

test("tar.gz extraction writes only the expected binary and rejects traversal and links", t => {
  const root = temporary(t, "xora-syft-tar");
  const archive = path.join(root, "valid.tar.gz");
  fs.writeFileSync(archive, tarGzip([
    tarEntry("LICENSE", Buffer.from("license")),
    tarEntry("syft", Buffer.from("binary"))
  ]));
  const binary = path.join(root, "syft");
  extractTarGzipBinary(archive, binary, "syft");
  assert.equal(fs.readFileSync(binary, "utf8"), "binary");

  const traversal = path.join(root, "traversal.tar.gz");
  fs.writeFileSync(traversal, tarGzip([tarEntry("../syft", Buffer.from("bad"))]));
  assert.throws(() => extractTarGzipBinary(traversal, path.join(root, "other"), "syft"), /path traversal/u);

  const link = path.join(root, "link.tar.gz");
  fs.writeFileSync(link, tarGzip([tarEntry("syft", Buffer.alloc(0), "2", "/tmp/other")]));
  assert.throws(() => extractTarGzipBinary(link, path.join(root, "linked"), "syft"), /links are not allowed/u);
});

test("zip extraction writes only syft.exe and rejects traversal and symlinks", t => {
  const root = temporary(t, "xora-syft-zip");
  const archive = path.join(root, "valid.zip");
  fs.writeFileSync(archive, zipStore([
    { name: "README.md", contents: "readme" },
    { name: "syft.exe", contents: "binary" }
  ]));
  const binary = path.join(root, "syft.exe");
  extractZipBinary(archive, binary, "syft.exe");
  assert.equal(fs.readFileSync(binary, "utf8"), "binary");

  const traversal = path.join(root, "traversal.zip");
  fs.writeFileSync(traversal, zipStore([{ name: "../syft.exe", contents: "bad" }]));
  assert.throws(() => extractZipBinary(traversal, path.join(root, "other.exe"), "syft.exe"), /path traversal/u);

  const symlink = path.join(root, "symlink.zip");
  fs.writeFileSync(symlink, zipStore([{ name: "syft.exe", contents: "target", externalAttributes: (0o120777 << 16) >>> 0 }]));
  assert.throws(() => extractZipBinary(symlink, path.join(root, "link.exe"), "syft.exe"), /links are not allowed/u);
});

test("version and scan processes always use shell:false and exact Syft arguments", t => {
  const root = temporary(t, "xora-syft-spawn");
  const sbom = path.join(root, "result.cdx.json");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "version") return { status: 0, stdout: "Application: syft\nVersion: 1.48.0\n", stderr: "" };
    fs.writeFileSync(sbom, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6" }));
    return { status: 0, stdout: "", stderr: "" };
  };
  verifySyftVersion("/cache/syft", "1.48.0", spawn);
  runSyft("/cache/syft", root, sbom, spawn);
  runSyft("/cache/syft", root, sbom, spawn, ["./applications/electron/dist/**"]);
  assert.deepEqual(calls.map(call => call.args), [
    ["version"],
    ["dir:.", "-o", `cyclonedx-json=${sbom}`],
    ["dir:.", "--exclude", "./applications/electron/dist/**", "-o", `cyclonedx-json=${sbom}`]
  ]);
  for (const call of calls) assert.equal(call.options.shell, false);
  assert.equal(calls[1].options.cwd, root);
  assert.equal(calls[1].options.env.SYFT_CHECK_FOR_APP_UPDATE, "false");
  assert.throws(
    () => runSyft("/cache/syft", root, sbom, spawn, ["../dist/**"]),
    /invalid Syft exclusion pattern/u
  );
});

test("checksum merge is idempotent and collapses old SBOM entries", t => {
  const root = temporary(t, "xora-syft-checksum");
  const sbom = path.join(root, "Xora-Code-0.1.0-linux-x64.cdx.json");
  const checksums = path.join(root, "SHA256SUMS-linux-x64.txt");
  fs.writeFileSync(sbom, "sbom");
  fs.writeFileSync(checksums, `${"a".repeat(64)}  installer.deb\n${"b".repeat(64)}  ${path.basename(sbom)}\n${"c".repeat(64)}  ${path.basename(sbom)}\n`);
  addSbomChecksum(checksums, sbom);
  addSbomChecksum(checksums, sbom);
  const lines = fs.readFileSync(checksums, "utf8").trim().split("\n");
  assert.equal(lines.filter(line => line.endsWith(`  ${path.basename(sbom)}`)).length, 1);
  assert.match(lines.find(line => line.endsWith(`  ${path.basename(sbom)}`)), new RegExp(`^${crypto.createHash("sha256").update("sbom").digest("hex")}`, "u"));
});

test("SBOM sanitization removes the native checkout root from all string fields", t => {
  const root = temporary(t, "xora-syft-redaction");
  const sbom = path.join(root, "result.cdx.json");
  fs.writeFileSync(sbom, JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: [{ name: path.join(root, "node_modules", "example", "binary"), properties: [{ value: `${root}/yarn.lock` }] }]
  }));
  sanitizeSbomBuildPaths(sbom, root);
  const contents = fs.readFileSync(sbom, "utf8");
  assert.equal(contents.includes(root), false);
  assert.match(contents, /\/node_modules\/example\/binary/u);
  assert.match(contents, /\/yarn\.lock/u);
});

test("distribution SBOM input must be an unpacked application with shipped sidecar and legal assets", t => {
  const root = temporary(t, "xora-syft-package-root");
  assert.throws(() => validatePackagedApplicationRoot(root, "linux-x64"), /missing resources\/app\.asar/u);
  for (const relative of [
    "resources/app.asar",
    "resources/sidecars/grok/grok",
    "resources/sidecars/grok/release.json",
    "resources/legal/THIRD-PARTY-NOTICES.md",
    "resources/legal/dependencies/LEGAL-INVENTORY.json"
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  assert.equal(validatePackagedApplicationRoot(root, "linux-x64"), path.resolve(root));
});

test("payload and locked dependency inventories merge without duplicate components or dependency edges", () => {
  const merged = mergeCycloneDxDocuments({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: { name: "Xora Code" }, tools: { components: [{ "bom-ref": "syft" }] } },
    components: [{ "bom-ref": "app", name: "Xora Code" }],
    dependencies: [{ ref: "app", dependsOn: ["shared"] }]
  }, {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { tools: { components: [{ "bom-ref": "syft" }] } },
    components: [{ "bom-ref": "app", name: "duplicate" }, { "bom-ref": "shared", name: "dependency" }],
    dependencies: [{ ref: "app", dependsOn: ["shared", "other"] }]
  });
  assert.equal(merged.metadata.component.name, "Xora Code");
  assert.deepEqual(merged.components.map(component => component["bom-ref"]), ["app", "shared"]);
  assert.deepEqual(merged.dependencies, [{ ref: "app", dependsOn: ["other", "shared"] }]);
  assert.deepEqual(merged.metadata.properties, [{
    name: "xora:inventory-scope",
    value: "packaged-payload-plus-locked-build-dependencies"
  }]);
});

test("Debian product component uses the public product name without changing references", () => {
  const document = {
    components: [
      { "bom-ref": "pkg:deb/xora-code@0.2.4?arch=amd64", name: "xora-code", version: "0.2.4", purl: "pkg:deb/xora-code@0.2.4?arch=amd64" },
      { "bom-ref": "npm:xora-code", name: "xora-code", version: "0.2.4", purl: "pkg:npm/xora-code@0.2.4" }
    ],
    dependencies: [{ ref: "pkg:deb/xora-code@0.2.4?arch=amd64", dependsOn: ["npm:xora-code"] }]
  };
  const duplicate = structuredClone(document);
  duplicate.components.push({ name: "xora-code", version: "0.2.4", purl: "pkg:deb/xora-code@0.2.4?arch=arm64" });
  const normalized = normalizeProductComponent(document, { name: "Xora Code", packageName: "xora-code", version: "0.2.4" });
  assert.equal(normalized.components[0].name, "Xora Code");
  assert.equal(normalized.components[1].name, "xora-code");
  assert.deepEqual(normalized.dependencies, document.dependencies);

  assert.throws(
    () => normalizeProductComponent(duplicate, { name: "Xora Code", packageName: "xora-code", version: "0.2.4" }),
    /multiple xora-code product components/u
  );
});

test("unpacked payload inventory receives one explicit top-level product component", () => {
  const document = {
    components: [
      { "bom-ref": "npm:xora-code", name: "xora-code", version: "0.2.4", purl: "pkg:npm/xora-code@0.2.4" }
    ]
  };
  const normalized = normalizeProductComponent(document, {
    name: "Xora Code",
    packageName: "xora-code",
    version: "0.2.4"
  });
  const product = normalized.components.find(component => component.purl === "pkg:generic/xora-code@0.2.4");
  assert.deepEqual(product, {
    "bom-ref": "pkg:generic/xora-code@0.2.4",
    type: "application",
    name: "Xora Code",
    version: "0.2.4",
    purl: "pkg:generic/xora-code@0.2.4",
    licenses: [{ license: { id: "Apache-2.0" } }]
  });

  normalizeProductComponent(normalized, {
    name: "Xora Code",
    packageName: "xora-code",
    version: "0.2.4"
  });
  assert.equal(normalized.components.filter(component => component.purl === "pkg:generic/xora-code@0.2.4").length, 1);
});

test("end-to-end wrapper verifies download hash, reuses cache, and updates checksums", async t => {
  const root = temporary(t, "xora-syft-integration");
  const packageRoot = path.join(root, "linux-unpacked");
  const archiveContents = tarGzip([tarEntry("syft", Buffer.from("fake-binary"))]);
  const digest = crypto.createHash("sha256").update(archiveContents).digest("hex");
  const lock = {
    schemaVersion: 1,
    tool: "syft",
    version: "1.48.0",
    maximumArchiveBytes: 1024 * 1024,
    targets: {
      "linux-x64": {
        archive: "tar.gz",
        binary: "syft",
        fileName: "syft_1.48.0_linux_amd64.tar.gz",
        url: "https://github.com/anchore/syft/releases/download/v1.48.0/syft_1.48.0_linux_amd64.tar.gz",
        sha256: digest
      }
    }
  };
  const lockFile = path.join(root, "lock.json");
  const output = path.join(root, "assets");
  const cache = path.join(root, "cache");
  fs.mkdirSync(output);
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  fs.writeFileSync(path.join(output, "SHA256SUMS-linux-x64.txt"), `${"a".repeat(64)}  Xora-Code-${applicationVersion}-linux-amd64.deb\n`);
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(archiveContents, { status: 200 });
  };
  const spawnImpl = (command, args, options) => {
    assert.equal(options.shell, false);
    if (args[0] === "version") return { status: 0, stdout: "Application: syft\nVersion: 1.48.0\n", stderr: "" };
    const outputArgument = args.find(argument => argument.startsWith("cyclonedx-json="));
    fs.writeFileSync(outputArgument.slice("cyclonedx-json=".length), JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: `${options.cwd}/component` }]
    }));
    return { status: 0, stdout: "", stderr: "" };
  };
  for (const relative of [
    "resources/app.asar",
    "resources/sidecars/grok/grok",
    "resources/sidecars/grok/release.json",
    "resources/legal/THIRD-PARTY-NOTICES.md",
    "resources/legal/dependencies/LEGAL-INVENTORY.json"
  ]) {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  const options = { target: "linux-x64", cacheDirectory: cache, outputDirectory: output, sourceDirectory: packageRoot };
  await generatePreviewSbom(options, { lockPath: lockFile, fetchImpl, spawnImpl });
  await generatePreviewSbom(options, { lockPath: lockFile, fetchImpl: async () => { throw new Error("cache was not reused"); }, spawnImpl });
  assert.equal(fetches, 1);
  const sbomName = `Xora-Code-${applicationVersion}-linux-x64.cdx.json`;
  assert.ok(fs.existsSync(path.join(output, sbomName)));
  assert.equal(fs.readFileSync(path.join(output, sbomName), "utf8").includes(root), false);
  assert.equal(fs.readFileSync(path.join(output, "SHA256SUMS-linux-x64.txt"), "utf8").split(sbomName).length - 1, 1);
});
