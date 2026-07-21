// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPreviewAssets } from "../verify-preview-assets.mjs";

const commit = "a".repeat(40);
const version = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;

function digest(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xora-native-assets-"));
  const files = new Map([
    [`Xora Code-${version}-linux-x86_64.AppImage`, "appimage"],
    [`Xora Code-${version}-linux-amd64.deb`, "deb"],
    [`Xora-Code-${version}-linux-x64-PREVIEW.json`, `${JSON.stringify({
      schemaVersion: 1,
      product: "xora-code",
      version,
      target: "linux-x64",
      commit,
      preview: true,
      productionSigned: false,
      signature: "SHA-256 checksums only",
    })}\n`],
    [`Xora-Code-${version}-linux-x64.cdx.json`, `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: { properties: [{
        name: "xora:inventory-scope",
        value: "packaged-payload-plus-locked-build-dependencies",
      }] },
      components: [
        { type: "application", name: "Xora Code", version },
        { type: "library", name: "react", version: "18.3.1", purl: "pkg:npm/react@18.3.1" },
      ],
    })}\n`],
  ]);
  for (const [name, contents] of files) fs.writeFileSync(path.join(root, name), contents);
  writeChecksums(root);
  return root;
}

function writeChecksums(root) {
  const checksum = path.join(root, "SHA256SUMS-linux-x64.txt");
  const sums = fs.readdirSync(root)
    .filter(name => name !== path.basename(checksum))
    .sort((left, right) => left.localeCompare(right))
    .map(name => `${digest(fs.readFileSync(path.join(root, name)))}  ${name}`)
    .join("\n");
  fs.writeFileSync(checksum, `${sums}\n`);
}

test("verifies a complete native preview asset set", () => {
  const root = fixture();
  const result = verifyPreviewAssets({ target: "linux-x64", commit, assetsDirectory: root });
  assert.equal(result.files.length, 5);
  assert.equal(result.sbomComponents, 2);
});

test("rejects a provenance commit mismatch", () => {
  const root = fixture();
  const provenance = path.join(root, `Xora-Code-${version}-linux-x64-PREVIEW.json`);
  fs.writeFileSync(provenance, fs.readFileSync(provenance, "utf8").replace(commit, "b".repeat(40)));
  assert.throws(
    () => verifyPreviewAssets({ target: "linux-x64", commit, assetsDirectory: root }),
    /checksum mismatch/u,
  );
});

test("rejects an unchecksummed extra asset", () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "unexpected.txt"), "unexpected");
  assert.throws(
    () => verifyPreviewAssets({ target: "linux-x64", commit, assetsDirectory: root }),
    /unexpected preview assets/u,
  );
});

test("rejects a checksummed asset outside the exact release set", () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "Xora Code-0.0.0-linux-x86_64.AppImage"), "stale-appimage");
  writeChecksums(root);
  assert.throws(
    () => verifyPreviewAssets({ target: "linux-x64", commit, assetsDirectory: root }),
    /unexpected preview assets/u,
  );
});

test("rejects an empty CycloneDX component inventory", () => {
  const root = fixture();
  const sbom = path.join(root, `Xora-Code-${version}-linux-x64.cdx.json`);
  fs.writeFileSync(sbom, `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [] })}\n`);
  writeChecksums(root);
  assert.throws(
    () => verifyPreviewAssets({ target: "linux-x64", commit, assetsDirectory: root }),
    /invalid CycloneDX SBOM/u,
  );
});

test("rejects a payload-only or source-only SBOM without the combined inventory scope", () => {
  const root = fixture();
  const sbom = path.join(root, `Xora-Code-${version}-linux-x64.cdx.json`);
  fs.writeFileSync(sbom, `${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: [
      { type: "application", name: "Xora Code", version },
      { type: "library", name: "react", purl: "pkg:npm/react@18.3.1" },
    ],
  })}\n`);
  writeChecksums(root);
  assert.throws(
    () => verifyPreviewAssets({ target: "linux-x64", commit, assetsDirectory: root }),
    /invalid CycloneDX SBOM/u,
  );
});
