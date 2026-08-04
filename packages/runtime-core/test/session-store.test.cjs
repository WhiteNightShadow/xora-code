const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { appendFile, mkdtemp, readFile, rm, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { JsonlSessionStore, SecretRedactor } = require("../dist/index.js");

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "whitenight-session-test-"));
  roots.push(root);
  return { root, store: new JsonlSessionStore(root, { durable: false, ...options }) };
}

describe("JsonlSessionStore", () => {
  it("serializes concurrent appends with monotonic sequence numbers", async () => {
    const fixture = await store();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => fixture.store.append("session-1", { index })),
    );
    const records = await fixture.store.read("session-1");
    assert.deepEqual(records.map((record) => record.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
    const file = await stat(join(fixture.root, "session-1.jsonl"));
    assert.equal(file.isFile(), true);
    if (process.platform !== "win32") assert.equal(file.mode & 0o777, 0o600);
  });

  it("ignores and repairs an incomplete crash tail", async () => {
    const fixture = await store();
    await fixture.store.append("recoverable", { value: 1 });
    await appendFile(join(fixture.root, "recoverable.jsonl"), '{"partial":');

    const reopened = new JsonlSessionStore(fixture.root, { durable: false });
    assert.equal((await reopened.read("recoverable")).length, 1);
    await reopened.append("recoverable", { value: 2 });
    const records = await reopened.read("recoverable");
    assert.deepEqual(records.map((record) => record.event.value), [1, 2]);
    assert.doesNotMatch(await readFile(join(fixture.root, "recoverable.jsonl"), "utf8"), /partial/);
  });

  it("redacts secrets before persistence and rejects path traversal", async () => {
    const fixture = await store({ redactor: new SecretRedactor({ knownSecrets: ["private-value"] }) });
    await fixture.store.append("safe-id", { apiKey: "private-value", text: "private-value" });
    const disk = await readFile(join(fixture.root, "safe-id.jsonl"), "utf8");
    assert.doesNotMatch(disk, /private-value/);
    await assert.rejects(fixture.store.append("../escape", { value: true }), /Unsafe session id/);
  });
});
