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

test("silently drops late responses for timed-out and cancelled requests", async () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  const client = new AcpClient({
    write: () => undefined,
    defaultTimeoutMs: 5,
    lateResponseTombstoneMs: 1_000,
  });
  client.onError((error) => errors.push(error));
  const consuming = client.consume(input);

  const timedOut = client.startRequest("slow");
  await assert.rejects(timedOut.promise, AcpTimeoutError);
  input.write(response(timedOut.id, { tooLate: true }));

  const cancelled = client.startRequest("session/prompt", { sessionId: "s1" }, { timeoutMs: 0 });
  const cancelledRejection = assert.rejects(cancelled.promise, AcpCancelledError);
  await cancelled.cancel("user stopped");
  await cancelledRejection;
  input.write(response(cancelled.id, { tooLate: true }));

  await tick();
  assert.deepEqual(errors, []);
  assert.equal(client.closed, false);
  input.end();
  await consuming;
});

test("bounds and expires late-response tombstones while unknown numeric ids still report", async () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  const ids = [101, 102, 103];
  const client = new AcpClient({
    write: () => undefined,
    defaultTimeoutMs: 0,
    lateResponseTombstoneMs: 100,
    maxLateResponseTombstones: 1,
    createId: () => ids.shift() ?? 999,
  });
  client.onError((error) => errors.push(error));
  const consuming = client.consume(input);

  const first = client.startRequest("first");
  const firstRejection = assert.rejects(first.promise, AcpCancelledError);
  await first.cancel();
  await firstRejection;

  const second = client.startRequest("second");
  const secondRejection = assert.rejects(second.promise, AcpCancelledError);
  await second.cancel();
  await secondRejection;

  input.write(response(first.id, {})); // evicted by the one-entry bound
  input.write(response(second.id, {})); // retained and ignored
  await tick();
  assert.deepEqual(errors.map((error) => (error as AcpUnknownResponseError).requestId), [101]);

  await new Promise((resolve) => setTimeout(resolve, 125));
  input.write(response(second.id, {})); // expired and now genuinely unknown
  input.write(response(999, {})); // never issued
  await tick();

  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error instanceof AcpUnknownResponseError));
  assert.deepEqual(errors.map((error) => (error as AcpUnknownResponseError).requestId), [101, 102, 999]);
  input.end();
  await consuming;
});

test("does not reuse request ids while a late-response tombstone is active", async () => {
  const ids = [7, 7];
  const client = new AcpClient({
    write: () => undefined,
    defaultTimeoutMs: 0,
    createId: () => ids.shift() ?? 8,
  });
  const first = client.startRequest("first");
  const firstRejection = assert.rejects(first.promise, AcpCancelledError);
  await first.cancel();
  await firstRejection;
  assert.throws(() => client.startRequest("second"), /duplicate or recently retired id 7/);
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

test("preserves canonical MCP DTOs and leading-underscore extension methods on the wire", async () => {
  const input = new PassThrough();
  const writes: string[] = [];
  const client = new AcpClient({ write: (line) => { writes.push(line); }, defaultTimeoutMs: 0 });
  const consuming = client.consume(input);
  const mcpServers = [
    {
      name: "fixture-stdio",
      command: "/fixture/mcp-server",
      args: ["--stdio"],
      env: [{ name: "FIXTURE_TOKEN", value: "secret-ref:test" }],
      _meta: { owner: "xora" },
    },
    {
      type: "http",
      name: "fixture-http",
      url: "https://mcp.example.test/http",
      headers: [{ name: "Authorization", value: "secret-ref:http" }],
    },
    {
      type: "sse",
      name: "fixture-sse",
      url: "https://mcp.example.test/sse",
      headers: [],
    },
  ];

  const created = client.startRequest<{ sessionId: string }>("session/new", {
    cwd: "/fixture/project",
    mcpServers,
  });
  const loaded = client.startRequest("session/load", {
    sessionId: "fixture-session",
    cwd: "/fixture/project",
    mcpServers,
  });
  const updated = client.startRequest("_x.ai/session/update_mcp_servers", {
    sessionId: "fixture-session",
    mcpServers,
  });
  const listed = client.startRequest("_x.ai/mcp/list", {
    sessionId: "fixture-session",
    cache: false,
  });
  await client.drain();

  const messages = writes.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(messages.map((message) => message.method), [
    "session/new",
    "session/load",
    "_x.ai/session/update_mcp_servers",
    "_x.ai/mcp/list",
  ]);
  assert.deepEqual((messages[0]?.params as Record<string, unknown>).mcpServers, mcpServers);
  assert.deepEqual((messages[1]?.params as Record<string, unknown>).mcpServers, mcpServers);
  assert.deepEqual(messages[2]?.params, { sessionId: "fixture-session", mcpServers });
  assert.deepEqual(messages[3]?.params, { sessionId: "fixture-session", cache: false });

  input.write(response(created.id, { sessionId: "fixture-session" }));
  input.write(response(loaded.id, {}));
  input.write(response(updated.id, { ok: true }));
  input.write(response(listed.id, { servers: [] }));
  await Promise.all([created.promise, loaded.promise, updated.promise, listed.promise]);
  input.end();
  await consuming;
});

test("routes Grok MCP readiness notifications without normalizing extension names", async () => {
  const input = new PassThrough();
  const received: Array<{ method: string; params: unknown }> = [];
  const client = new AcpClient({ write: () => undefined, defaultTimeoutMs: 0 });
  const methods = [
    "_x.ai/mcp/init_progress",
    "_x.ai/mcp_initialized",
    "_x.ai/mcp/tools_changed",
    "_x.ai/mcp/server_status",
  ];
  for (const subscribedMethod of methods) {
    client.onNotification(subscribedMethod, (params, method) => {
      received.push({ method, params });
    });
  }
  const consuming = client.consume(input);

  for (const [index, method] of methods.entries()) {
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: { sessionId: "fixture-session", sequence: index },
    })}\n`);
  }
  await tick();
  assert.deepEqual(received, methods.map((method, sequence) => ({
    method,
    params: { sessionId: "fixture-session", sequence },
  })));
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
