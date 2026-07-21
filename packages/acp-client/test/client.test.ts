import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AcpCancelledError,
  AcpClient,
  AcpLineTooLongError,
  AcpRemoteError,
  AcpTimeoutError,
  AcpUnknownResponseError,
} from "../src/index.js";

function response(id: string | number, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("associates out-of-order responses and preserves serialized writes", async () => {
  const input = new PassThrough();
  const writes: string[] = [];
  const client = new AcpClient({ write: (line) => { writes.push(line); }, defaultTimeoutMs: 0 });
  const consuming = client.consume(input);

  const first = client.startRequest<{ value: string }>("first", { n: 1 });
  const second = client.startRequest<{ value: string }>("second", { n: 2 });
  await client.drain();
  assert.deepEqual(writes.map((line) => JSON.parse(line).method), ["first", "second"]);

  input.write(response(second.id, { value: "two" }));
  input.write(response(first.id, { value: "one" }));
  assert.deepEqual(await second.promise, { value: "two" });
  assert.deepEqual(await first.promise, { value: "one" });
  assert.equal(client.pendingRequestCount, 0);

  input.end();
  await consuming;
});

test("surfaces structured remote errors", async () => {
  const input = new PassThrough();
  const client = new AcpClient({ write: () => undefined, defaultTimeoutMs: 0 });
  const consuming = client.consume(input);
  const call = client.startRequest("session/new", {});
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: call.id,
    error: { code: -32001, message: "Authentication required", data: { authRequired: true } },
  })}\n`);

  await assert.rejects(call.promise, (error: unknown) => {
    assert.ok(error instanceof AcpRemoteError);
    assert.equal(error.rpcCode, -32001);
    assert.equal(error.method, "session/new");
    assert.deepEqual(error.data, { authRequired: true });
    return true;
  });
  input.end();
  await consuming;
});

test("times out and supports AbortSignal with an ACP cancellation notification", async () => {
  const timeoutClient = new AcpClient({ write: () => undefined, defaultTimeoutMs: 10 });
  await assert.rejects(timeoutClient.request("slow"), AcpTimeoutError);
  timeoutClient.close();

  const writes: string[] = [];
  const controller = new AbortController();
  const client = new AcpClient({ write: (line) => { writes.push(line); }, defaultTimeoutMs: 0 });
  const call = client.startRequest("session/prompt", { sessionId: "s1" }, {
    signal: controller.signal,
    cancellation: { method: "session/cancel", params: { sessionId: "s1" } },
  });
  await client.drain();
  controller.abort("user stopped");
  await assert.rejects(call.promise, (error: unknown) => {
    assert.ok(error instanceof AcpCancelledError);
    assert.equal(error.reason, "user stopped");
    return true;
  });
  await client.drain();
  assert.deepEqual(writes.map((line) => JSON.parse(line).method), ["session/prompt", "session/cancel"]);
  client.close();
});

test("routes notifications and answers inbound permission requests without blocking reads", async () => {
  const input = new PassThrough();
  const writes: string[] = [];
  const updates: unknown[] = [];
  const client = new AcpClient({ write: (line) => { writes.push(line); }, defaultTimeoutMs: 0 });
  client.onNotification("session/update", (params) => { updates.push(params); });
  client.onRequest("session/request_permission", async () => {
    await tick();
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });
  const consuming = client.consume(input);

  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
  })}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "permission-1",
    method: "session/request_permission",
    params: { sessionId: "s1" },
  })}\n`);

  await tick();
  await tick();
  await client.drain();
  assert.equal(updates.length, 1);
  assert.deepEqual(JSON.parse(writes[0] ?? "null"), {
    jsonrpc: "2.0",
    id: "permission-1",
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  input.end();
  await consuming;
});

test("reports unknown response ids without taking down the connection", async () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  const client = new AcpClient({ write: () => undefined, defaultTimeoutMs: 0 });
  client.onError((error) => errors.push(error));
  const consuming = client.consume(input);
  input.write(response(999, {}));
  await tick();
  assert.ok(errors[0] instanceof AcpUnknownResponseError);
  assert.equal(client.closed, false);
  input.end();
  await consuming;
});

test("promotes Grok lifecycle pseudo-responses with string ids into notifications", async () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  const methods: string[] = [];
  const client = new AcpClient({ write: () => undefined, defaultTimeoutMs: 0 });
  client.onError((error) => errors.push(error));
  client.onNotification("skills-reload", (_params, method) => {
    methods.push(method);
  });
  const consuming = client.consume(input);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "skills-reload", result: { ok: true } })}\n`);
  await tick();
  assert.deepEqual(methods, ["skills-reload"]);
  assert.equal(errors.length, 0);
  assert.equal(client.closed, false);
  input.end();
  await consuming;
});

test("bounds inbound line size", async () => {
  const client = new AcpClient({ write: () => undefined, maxLineBytes: 8, defaultTimeoutMs: 0 });
  async function* oversized(): AsyncGenerator<Uint8Array> {
    yield Buffer.from("123456789");
  }
  await assert.rejects(client.consume(oversized()), AcpLineTooLongError);
});

test("awaits write backpressure and keeps wire order", async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const client = new AcpClient({
    defaultTimeoutMs: 0,
    write: (line) => new Promise<void>((resolve) => {
      started.push(JSON.parse(line).method);
      releases.push(resolve);
    }),
  });

  const first = client.notify("one");
  const second = client.notify("two");
  await tick();
  assert.deepEqual(started, ["one"]);
  releases.shift()?.();
  await first;
  await tick();
  assert.deepEqual(started, ["one", "two"]);
  releases.shift()?.();
  await second;
  client.close();
});
