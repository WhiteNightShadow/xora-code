import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { verifyStagedSidecarNotices } = require(
  join(repositoryRoot, "applications/electron/scripts/verify-sidecar.js"),
);

const noticeSources = [
  [join(repositoryRoot, "LICENSE"), "XORA-CODE-LICENSE"],
  [join(repositoryRoot, "NOTICE.md"), "XORA-CODE-NOTICE.md"],
  [join(repositoryRoot, "THIRD-PARTY-NOTICES.md"), "THIRD-PARTY-NOTICES.md"],
  [join(repositoryRoot, "resources/legal/ripgrep/RIPGREP-SOURCE-BUILD-NOTICE.md"), "RIPGREP-SOURCE-BUILD-NOTICE.md"],
  [join(repositoryRoot, "build/grok/PATCHES.md"), "GROK-BUILD-COMPATIBILITY-PATCHES.md"],
  [join(repositoryRoot, "resources/legal/grok-build/LICENSE"), "GROK-BUILD-LICENSE"],
  [join(repositoryRoot, "resources/legal/grok-build/THIRD-PARTY-NOTICES"), "GROK-BUILD-THIRD-PARTY-NOTICES"],
  [join(repositoryRoot, "resources/legal/grok-build/crates/xai-grok-tools/THIRD_PARTY_NOTICES.md"), "GROK-TOOLS-THIRD-PARTY-NOTICES.md"],
  [join(repositoryRoot, "resources/legal/grok-build/crates/xai-ratatui-inline/NOTICE"), "XAI-RATATUI-INLINE-NOTICE"],
  [join(repositoryRoot, "resources/legal/grok-build/crates/xai-ratatui-textarea/NOTICE"), "XAI-RATATUI-TEXTAREA-NOTICE"],
  [join(repositoryRoot, "resources/legal/grok-build/third_party/NOTICE"), "GROK-VENDORED-NOTICE"],
];

async function createValidSidecarRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "xora-sidecar-notices-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const notices = join(root, "notices");
  await mkdir(notices);
  await Promise.all(noticeSources.map(([source, name]) => copyFile(source, join(notices, name))));
  return { root, notices };
}

test("staged sidecar accepts the exact 11 audited notices", async (context) => {
  const { root, notices } = await createValidSidecarRoot(context);
  assert.equal((await readdir(notices)).length, 11);
  assert.doesNotThrow(() => verifyStagedSidecarNotices(root));
});

test("staged sidecar rejects a missing compatibility patch notice", async (context) => {
  const { root, notices } = await createValidSidecarRoot(context);
  await rm(join(notices, "GROK-BUILD-COMPATIBILITY-PATCHES.md"));
  assert.throws(
    () => verifyStagedSidecarNotices(root),
    /notice set mismatch.*GROK-BUILD-COMPATIBILITY-PATCHES\.md/u,
  );
});

test("staged sidecar rejects an extra notice", async (context) => {
  const { root, notices } = await createValidSidecarRoot(context);
  await writeFile(join(notices, "UNREVIEWED-NOTICE"), "unexpected\n", "utf8");
  assert.throws(
    () => verifyStagedSidecarNotices(root),
    /notice set mismatch.*UNREVIEWED-NOTICE/u,
  );
});

test("staged sidecar rejects notice bytes that differ from the authoritative source", async (context) => {
  const { root, notices } = await createValidSidecarRoot(context);
  await writeFile(join(notices, "XORA-CODE-NOTICE.md"), "modified\n", "utf8");
  assert.throws(
    () => verifyStagedSidecarNotices(root),
    /does not match its authoritative source: XORA-CODE-NOTICE\.md/u,
  );
});
