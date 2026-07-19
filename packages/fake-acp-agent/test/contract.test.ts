import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

type PermissionMode = "allow" | "cancel";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class RpcHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly notifications: RpcMessage[] = [];
  readonly permissionRequests: RpcMessage[] = [];
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #permissionMode: PermissionMode;
  readonly #stderr: string[] = [];
  #nextId = 1;

  constructor(permissionMode: PermissionMode = "allow") {
    this.#permissionMode = permissionMode;
    const main = path.resolve(__dirname, "../src/main.js");
    this.child = spawn(process.execPath, [main], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.#stderr.push(chunk));
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#onLine(JSON.parse(line) as RpcMessage));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) await once(this.child, "exit");
    assert.equal(this.#stderr.join(""), "");
  }

  #onLine(message: RpcMessage): void {
    if (message.method) {
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        this.#onAgentRequest(message);
      } else {
        this.notifications.push(message);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      const error = new Error(`${message.error.code}: ${message.error.message}`);
      Object.assign(error, { code: message.error.code, data: message.error.data });
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  #onAgentRequest(message: RpcMessage): void {
    if (message.method !== "session/request_permission") return;
    this.permissionRequests.push(message);
    const params = isRecord(message.params) ? message.params : {};
    if (this.#permissionMode === "cancel") {
      this.notify("session/cancel", { sessionId: params.sessionId });
      this.#write({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { outcome: { outcome: "cancelled" } },
      });
    } else {
      this.#write({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      });
    }
  }

  #write(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

test("stdio contract streams model, plan, text, tool, permission and diff fixtures", async () => {
  const rpc = new RpcHarness("allow");
  try {
    const initialized = await rpc.request<Record<string, unknown>>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    assert.equal(initialized.protocolVersion, 1);
    const meta = initialized._meta as Record<string, unknown>;
    assert.equal(meta.agentVersion, "0.2.103-fake");
    assert.ok(isRecord(meta.modelState));

    await rpc.request("authenticate", { methodId: "xai.api_key", _meta: { headless: true } });
    const created = await rpc.request<{ sessionId: string }>("session/new", {
      cwd: "/fixture/project",
      mcpServers: [],
    });
    assert.equal(created.sessionId, "fake-session-0001");

    const completed = await rpc.request<{ stopReason: string }>("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Apply the fixture" }],
    });
    assert.equal(completed.stopReason, "end_turn");
    assert.equal(rpc.permissionRequests.length, 1);

    const methods = rpc.notifications.map((message) => message.method);
    assert.ok(methods.includes("_x.ai/model_state_updated"));
    const updates = rpc.notifications
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update: Record<string, unknown> }).update);
    const kinds = updates.map((update) => update.sessionUpdate);
    assert.ok(kinds.includes("plan"));
    assert.ok(kinds.includes("agent_message_chunk"));
    assert.ok(kinds.includes("tool_call"));
    assert.ok(kinds.includes("tool_call_update"));

    const diffUpdate = updates.find((update) => {
      const content = update.content;
      return Array.isArray(content) && content.some((item) => isRecord(item) && item.type === "diff");
    });
    assert.ok(diffUpdate, "expected a completed tool update containing a diff fixture");
  } finally {
    await rpc.close();
  }
});

test("session/load replays deterministic history", async () => {
  const rpc = new RpcHarness();
  try {
    await rpc.request("initialize", { protocolVersion: 1 });
    await rpc.request("authenticate", { methodId: "grok.com" });
    await rpc.request("session/load", {
      sessionId: "persisted-session",
      cwd: "/fixture/project",
      mcpServers: [],
    });
    const replayKinds = rpc.notifications
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
    assert.deepEqual(replayKinds, ["user_message_chunk", "agent_message_chunk"]);
  } finally {
    await rpc.close();
  }
});

test("session/cancel finishes the in-flight prompt with cancelled", async () => {
  const rpc = new RpcHarness("cancel");
  try {
    await rpc.request("initialize", { protocolVersion: 1 });
    await rpc.request("authenticate", { methodId: "xai.api_key" });
    const { sessionId } = await rpc.request<{ sessionId: string }>("session/new", {
      cwd: "/fixture/project",
      mcpServers: [],
    });
    const result = await rpc.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Cancel this" }],
    });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(rpc.permissionRequests.length, 1);
  } finally {
    await rpc.close();
  }
});

test("rejects session setup before authentication with stable error data", async () => {
  const rpc = new RpcHarness();
  try {
    await rpc.request("initialize", { protocolVersion: 1 });
    await assert.rejects(
      rpc.request("session/new", { cwd: "/fixture/project", mcpServers: [] }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, -32001);
        assert.deepEqual((error as { data?: unknown }).data, { authRequired: true });
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
