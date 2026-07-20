import {
  AUTH_METHODS_FIXTURE,
  DIFF_FIXTURE,
  FAKE_AGENT_VERSION,
  FAKE_PROTOCOL_VERSION,
  MODEL_STATE_FIXTURE,
  PERMISSION_OPTIONS_FIXTURE,
  PLAN_FIXTURE,
  TOOL_CALL_FIXTURE,
  sessionIdFixture,
} from "./fixtures.js";
import type {
  AgentInput,
  AgentWrite,
  FakeAcpAgentOptions,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

interface Session {
  readonly id: string;
  readonly cwd: string;
  modelId: string;
}

interface ActiveTurn {
  readonly sessionId: string;
  readonly cancel: Promise<void>;
  cancelNow(): void;
  permissionRequestId?: JsonRpcId;
}

interface PendingClientRequest {
  resolve(response: JsonRpcResponse): void;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const AUTH_REQUIRED = -32001;
const INVALID_SESSION = -32002;
const TURN_ALREADY_ACTIVE = -32003;

export class FakeAcpAgent {
  readonly #write;
  readonly #maxLineBytes: number;
  readonly #sessions = new Map<string, Session>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #pendingClientRequests = new Map<JsonRpcId, PendingClientRequest>();
  #writeTail: Promise<void> = Promise.resolve();
  #initialized = false;
  #authenticated = false;
  #sessionSequence = 0;
  #clientRequestSequence = 0;

  constructor(write: AgentWrite, options: FakeAcpAgentOptions = {}) {
    this.#write = write;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
  }

  async run(input: AgentInput): Promise<void> {
    let buffer = Buffer.alloc(0);
    for await (const chunk of input) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        let end = newline;
        if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
        if (end > this.#maxLineBytes) {
          await this.#respondError(null, -32700, "Line exceeds fake agent limit");
        } else if (end > 0) {
          this.#routeLine(buffer.subarray(0, end).toString("utf8"));
        }
        buffer = buffer.subarray(newline + 1);
      }
      if (buffer.length > this.#maxLineBytes) {
        await this.#respondError(null, -32700, "Line exceeds fake agent limit");
        buffer = Buffer.alloc(0);
      }
    }
    if (buffer.length > 0) this.#routeLine(buffer.toString("utf8"));
    await this.drain();
  }

  async drain(): Promise<void> {
    await this.#writeTail;
  }

  #routeLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      void this.#respondError(null, -32700, "Parse error");
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      void this.#respondError(null, -32600, "Invalid Request");
      return;
    }

    if (typeof message.method === "string") {
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        void this.#handleRequest(message as unknown as JsonRpcRequest);
      } else {
        this.#handleNotification(message as unknown as JsonRpcNotification);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      this.#handleClientResponse(message as unknown as JsonRpcResponse);
      return;
    }
    void this.#respondError(null, -32600, "Invalid Request");
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      switch (request.method) {
        case "initialize":
          await this.#initialize(request);
          break;
        case "authenticate":
          await this.#authenticate(request);
          break;
        case "session/new":
          await this.#newSession(request);
          break;
        case "session/load":
          await this.#loadSession(request);
          break;
        case "session/prompt":
          await this.#prompt(request);
          break;
        case "session/set_model":
          await this.#setModel(request);
          break;
        case "session/cancel":
          this.#cancelSession(request.params);
          await this.#respondResult(request.id, {});
          break;
        default:
          await this.#respondError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (cause) {
      await this.#respondError(
        request.id,
        -32603,
        "Internal error",
        { detail: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "session/cancel") this.#cancelSession(notification.params);
  }

  #handleClientResponse(response: JsonRpcResponse): void {
    const pending = this.#pendingClientRequests.get(response.id);
    if (!pending) return;
    this.#pendingClientRequests.delete(response.id);
    pending.resolve(response);
  }

  async #initialize(request: JsonRpcRequest): Promise<void> {
    const params = asRecord(request.params);
    const requestedVersion = params?.protocolVersion;
    this.#initialized = true;
    await this.#respondResult(request.id, {
      protocolVersion: requestedVersion === FAKE_PROTOCOL_VERSION
        ? FAKE_PROTOCOL_VERSION
        : FAKE_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: {},
      },
      agentInfo: { name: "xora-code-fake-acp-agent", title: "Fake Grok Build", version: FAKE_AGENT_VERSION },
      authMethods: AUTH_METHODS_FIXTURE,
      _meta: {
        grokShell: true,
        defaultAuthMethodId: "xai.api_key",
        agentVersion: FAKE_AGENT_VERSION,
        modelState: MODEL_STATE_FIXTURE,
      },
    });
  }

  async #authenticate(request: JsonRpcRequest): Promise<void> {
    if (!this.#initialized) {
      await this.#respondError(request.id, -32000, "initialize must be called first");
      return;
    }
    const methodId = asRecord(request.params)?.methodId;
    if (typeof methodId !== "string" || !AUTH_METHODS_FIXTURE.some((method) => method.id === methodId)) {
      await this.#respondError(request.id, -32602, "Unknown authentication method");
      return;
    }
    this.#authenticated = true;
    await this.#respondResult(request.id, {});
  }

  async #newSession(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    if (!params || typeof params.cwd !== "string" || !Array.isArray(params.mcpServers)) {
      await this.#respondError(request.id, -32602, "session/new requires cwd and mcpServers");
      return;
    }
    const id = sessionIdFixture(++this.#sessionSequence);
    const requestedModel = asRecord(params._meta)?.modelId;
    this.#sessions.set(id, {
      id,
      cwd: params.cwd,
      modelId: typeof requestedModel === "string" ? requestedModel : MODEL_STATE_FIXTURE.currentModelId,
    });
    await this.#respondResult(request.id, {
      sessionId: id,
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: [modelConfigOption()],
      _meta: { modelState: modelState(this.#sessions.get(id)!.modelId) },
    });
    await this.#notifyModelState(id, this.#sessions.get(id)!.modelId);
  }

  async #loadSession(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    if (!params || typeof params.sessionId !== "string" || typeof params.cwd !== "string" || !Array.isArray(params.mcpServers)) {
      await this.#respondError(request.id, -32602, "session/load requires sessionId, cwd and mcpServers");
      return;
    }
    const requestedModel = asRecord(params._meta)?.modelId;
    const session = {
      id: params.sessionId,
      cwd: params.cwd,
      modelId: typeof requestedModel === "string" ? requestedModel : MODEL_STATE_FIXTURE.currentModelId,
    };
    this.#sessions.set(session.id, session);
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Restore the deterministic fixture." },
    });
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Fixture session restored." },
    });
    await this.#respondResult(request.id, {
      modes: {
        currentModeId: "code",
        availableModes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
      },
      configOptions: [modelConfigOption()],
      _meta: { modelState: modelState(session.modelId) },
    });
    await this.#notifyModelState(session.id, session.modelId);
  }

  async #prompt(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string" || !Array.isArray(params?.prompt)) {
      await this.#respondError(request.id, -32602, "session/prompt requires sessionId and prompt");
      return;
    }
    if (!this.#sessions.has(sessionId)) {
      await this.#respondError(request.id, INVALID_SESSION, "Unknown session");
      return;
    }
    if (this.#activeTurns.has(sessionId)) {
      await this.#respondError(request.id, TURN_ALREADY_ACTIVE, "A prompt is already active for this session");
      return;
    }

    const turn = createActiveTurn(sessionId);
    this.#activeTurns.set(sessionId, turn);
    try {
      await this.#notifyModelState(sessionId, this.#sessions.get(sessionId)?.modelId);
      await this.#sessionUpdate(sessionId, PLAN_FIXTURE);
      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I will apply the deterministic fixture edit. " },
      });
      await this.#sessionUpdate(sessionId, TOOL_CALL_FIXTURE);

      const permission = this.#requestClient("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: TOOL_CALL_FIXTURE.toolCallId,
          title: TOOL_CALL_FIXTURE.title,
          kind: TOOL_CALL_FIXTURE.kind,
          status: TOOL_CALL_FIXTURE.status,
          locations: TOOL_CALL_FIXTURE.locations,
          rawInput: TOOL_CALL_FIXTURE.rawInput,
        },
        options: PERMISSION_OPTIONS_FIXTURE,
      });
      turn.permissionRequestId = permission.id;

      const response = await Promise.race([
        permission.promise.then((value) => ({ type: "permission" as const, value })),
        turn.cancel.then(() => ({ type: "cancel" as const })),
      ]);
      if (response.type === "cancel") {
        this.#pendingClientRequests.delete(permission.id);
        await this.#cancelledTurn(request.id, sessionId);
        return;
      }

      const outcome = permissionOutcome(response.value);
      if (outcome === "cancelled") {
        await this.#cancelledTurn(request.id, sessionId);
        return;
      }
      if (outcome !== "allowed") {
        await this.#sessionUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: TOOL_CALL_FIXTURE.toolCallId,
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "Permission denied" } }],
        });
        await this.#sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Permission was denied." },
        });
        await this.#respondResult(request.id, { stopReason: "end_turn", _meta: { fixture: "denied" } });
        return;
      }

      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: TOOL_CALL_FIXTURE.toolCallId,
        status: "in_progress",
      });
      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: TOOL_CALL_FIXTURE.toolCallId,
        status: "completed",
        rawOutput: { changedFiles: 1 },
        content: [DIFF_FIXTURE],
      });
      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "plan",
        entries: PLAN_FIXTURE.entries.map((entry) => ({ ...entry, status: "completed" })),
      });
      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      });
      await this.#respondResult(request.id, { stopReason: "end_turn", _meta: { fixture: "complete" } });
    } finally {
      this.#activeTurns.delete(sessionId);
    }
  }

  async #setModel(request: JsonRpcRequest): Promise<void> {
    if (!await this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    const sessionId = params?.sessionId;
    const modelId = params?.modelId;
    if (typeof sessionId !== "string" || typeof modelId !== "string") {
      await this.#respondError(request.id, -32602, "session/set_model requires a valid sessionId and modelId");
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session ||
        !MODEL_STATE_FIXTURE.availableModels.some((model) => model.id === modelId)) {
      await this.#respondError(request.id, -32602, "session/set_model requires a valid sessionId and modelId");
      return;
    }
    session.modelId = modelId;
    await this.#respondResult(request.id, {});
    await this.#notifyModelState(sessionId, modelId);
  }

  async #cancelledTurn(requestId: JsonRpcId, sessionId: string): Promise<void> {
    await this.#sessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: TOOL_CALL_FIXTURE.toolCallId,
      status: "failed",
      rawOutput: { cancelled: true },
    });
    await this.#respondResult(requestId, { stopReason: "cancelled", _meta: { fixture: "cancelled" } });
  }

  #cancelSession(params: unknown): void {
    const sessionId = asRecord(params)?.sessionId;
    if (typeof sessionId === "string") this.#activeTurns.get(sessionId)?.cancelNow();
  }

  #requireAuthenticated(id: JsonRpcId): boolean {
    if (this.#initialized && this.#authenticated) return true;
    void this.#respondError(id, AUTH_REQUIRED, "Authentication required", { authRequired: true });
    return false;
  }

  #requestClient(method: string, params: unknown): { id: JsonRpcId; promise: Promise<JsonRpcResponse> } {
    const id = `fake-permission-${String(++this.#clientRequestSequence).padStart(4, "0")}`;
    const promise = new Promise<JsonRpcResponse>((resolve) => {
      this.#pendingClientRequests.set(id, { resolve });
    });
    void this.#send({ jsonrpc: "2.0", id, method, params });
    return { id, promise };
  }

  async #notifyModelState(sessionId: string, currentModelId?: string): Promise<void> {
    await this.#send({
      jsonrpc: "2.0",
      method: "_x.ai/model_state_updated",
      params: {
        sessionId,
        modelState: currentModelId
          ? { ...MODEL_STATE_FIXTURE, currentModelId }
          : MODEL_STATE_FIXTURE,
      },
    });
  }

  async #sessionUpdate(sessionId: string, update: unknown): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  async #respondResult(id: JsonRpcId, result: unknown): Promise<void> {
    await this.#send({ jsonrpc: "2.0", id, result });
  }

  async #respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.#send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  #send(message: JsonRpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const write = this.#writeTail.then(() => this.#write(line));
    this.#writeTail = Promise.resolve(write).then(() => undefined);
    return this.#writeTail;
  }
}

function modelConfigOption(): Record<string, unknown> {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: MODEL_STATE_FIXTURE.currentModelId,
    options: MODEL_STATE_FIXTURE.availableModels.map((model) => ({ value: model.id, name: model.name })),
  };
}

function modelState(currentModelId: string): Record<string, unknown> {
  return { ...MODEL_STATE_FIXTURE, currentModelId };
}

function permissionOutcome(response: JsonRpcResponse): "allowed" | "denied" | "cancelled" {
  if (response.error) return "denied";
  const result = asRecord(response.result);
  const outcome = asRecord(result?.outcome);
  if (outcome?.outcome === "cancelled") return "cancelled";
  if (outcome?.outcome !== "selected" || typeof outcome.optionId !== "string") return "denied";
  return outcome.optionId.startsWith("allow-") ? "allowed" : "denied";
}

function createActiveTurn(sessionId: string): ActiveTurn {
  let cancelNow!: () => void;
  const cancel = new Promise<void>((resolve) => {
    let cancelled = false;
    cancelNow = () => {
      if (cancelled) return;
      cancelled = true;
      resolve();
    };
  });
  return { sessionId, cancel, cancelNow };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
