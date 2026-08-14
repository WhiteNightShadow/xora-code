import {
  AVAILABLE_COMMANDS_FIXTURE,
  AUTH_METHODS_FIXTURE,
  DIFF_FIXTURE,
  FAKE_AGENT_VERSION,
  FAKE_PROTOCOL_VERSION,
  GOAL_OBJECTIVE_FIXTURE,
  MODEL_STATE_FIXTURE,
  PERMISSION_OPTIONS_FIXTURE,
  PLAN_APPROVAL_FIXTURE,
  PLAN_FIXTURE,
  PLAN_MODE_FIXTURE,
  TOOL_CALL_FIXTURE,
  goalUpdateFixture,
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
  reasoningEffort: string | undefined;
  modeId: "default" | "plan";
  mcpServers: McpServerConfig[];
  mcpState: "initializing" | "ready";
}

interface McpNameValue {
  readonly name: string;
  readonly value: string;
}

interface McpStdioServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: McpNameValue[];
  readonly _meta?: Record<string, unknown>;
}

interface McpRemoteServerConfig {
  readonly type: "http" | "sse";
  readonly name: string;
  readonly url: string;
  readonly headers: McpNameValue[];
  readonly _meta?: Record<string, unknown>;
}

type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

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
const INVALID_PARAMS = -32602;

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
        case "session/set_mode":
          await this.#setMode(request);
          break;
        case "_x.ai/session/update_mcp_servers":
          await this.#updateMcpServers(request);
          break;
        case "_x.ai/mcp/list":
          await this.#listMcpServers(request);
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
    const mcpServers = parseMcpServers(params?.mcpServers);
    if (!params || typeof params.cwd !== "string" || !mcpServers) {
      await this.#respondError(request.id, INVALID_PARAMS, "session/new requires cwd and valid mcpServers");
      return;
    }
    const id = sessionIdFixture(++this.#sessionSequence);
    const requestedModel = asRecord(params._meta)?.modelId;
    const session: Session = {
      id,
      cwd: params.cwd,
      modelId: typeof requestedModel === "string" ? requestedModel : MODEL_STATE_FIXTURE.currentModelId,
      reasoningEffort: "high",
      modeId: "default",
      mcpServers,
      mcpState: mcpServers.length === 0 ? "ready" : "initializing",
    };
    this.#sessions.set(id, session);
    await this.#respondResult(request.id, {
      sessionId: id,
      modes: {
        currentModeId: session.modeId,
        availableModes: [
          { id: "default", name: "Agent" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: [modelConfigOption()],
      _meta: { modelState: modelState(session.modelId, session.reasoningEffort) },
    });
    await this.#notifyModelState(id, session.modelId);
    await this.#sessionUpdate(id, AVAILABLE_COMMANDS_FIXTURE);
    await this.#notifyMcpInitializationStarted(session);
  }

  async #loadSession(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    const mcpServers = parseMcpServers(params?.mcpServers);
    if (!params || typeof params.sessionId !== "string" || typeof params.cwd !== "string" || !mcpServers) {
      await this.#respondError(request.id, INVALID_PARAMS, "session/load requires sessionId, cwd and valid mcpServers");
      return;
    }
    const requestedModel = asRecord(params._meta)?.modelId;
    const session: Session = {
      id: params.sessionId,
      cwd: params.cwd,
      modelId: typeof requestedModel === "string" ? requestedModel : MODEL_STATE_FIXTURE.currentModelId,
      reasoningEffort: "high",
      modeId: "default",
      mcpServers,
      mcpState: mcpServers.length === 0 ? "ready" : "initializing",
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
        currentModeId: session.modeId,
        availableModes: [{ id: "default", name: "Agent" }, { id: "plan", name: "Plan" }],
      },
      configOptions: [modelConfigOption()],
      _meta: { modelState: modelState(session.modelId, session.reasoningEffort) },
    });
    await this.#notifyModelState(session.id, session.modelId);
    await this.#sessionUpdate(session.id, AVAILABLE_COMMANDS_FIXTURE);
    await this.#notifyMcpInitializationStarted(session);
  }

  async #prompt(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string" || !Array.isArray(params?.prompt)) {
      await this.#respondError(request.id, -32602, "session/prompt requires sessionId and prompt");
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
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
      await this.#notifyModelState(sessionId, session.modelId);
      const promptText = textPrompt(params?.prompt);
      if (session.modeId === "plan") {
        await this.#planPrompt(request, session);
        return;
      }
      if (isGoalPrompt(promptText)) {
        await this.#goalPrompt(request, session, goalObjective(promptText));
        return;
      }
      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        messageId: `thought-${sessionId}-${String(request.id)}`,
        content: { type: "text", text: "Inspect the deterministic fixture before applying the edit." },
      });
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

  /**
   * Deterministic native `/goal` flow.  In particular, the all-completed plan
   * snapshot is emitted while the goal is still active and verifying.  This
   * mirrors Grok Build's cosmetic end-of-worker snapshot and guards clients
   * against marking the whole task complete too early.
   */
  async #goalPrompt(request: JsonRpcRequest, session: Session, objective: string): Promise<void> {
    const sessionId = session.id;
    await this.#notifyGoalState(sessionId, goalUpdateFixture({
      objective,
      phase: "planning",
      planning: true,
      tokens_used: 0,
      total_worker_rounds: 0,
      last_event: "goal_created",
    }));
    await this.#sessionUpdate(sessionId, PLAN_FIXTURE);
    await this.#notifyGoalState(sessionId, goalUpdateFixture({
      objective,
      status: "active",
      phase: "executing",
      tokens_used: 1_000,
      total_worker_rounds: 1,
      last_event: "worker_started",
    }));

    // A worker may close its plan rows before the goal verifier runs.  Xora
    // must keep the task in `verifying`, not turn this snapshot into success.
    await this.#sessionUpdate(sessionId, {
      sessionUpdate: "plan",
      entries: PLAN_FIXTURE.entries.map((entry) => ({ ...entry, status: "completed" })),
    });
    await this.#notifyGoalState(sessionId, goalUpdateFixture({
      objective,
      status: "active",
      phase: "executing",
      tokens_used: 1_500,
      total_worker_rounds: 1,
      total_verify_rounds: 1,
      verifying_completion: true,
      last_event: "verification_started",
    }));
    await this.#sessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The deterministic goal passed verification." },
    });
    await this.#notifyGoalState(sessionId, goalUpdateFixture({
      objective,
      status: "complete",
      phase: "idle",
      tokens_used: 2_000,
      elapsed_ms: 500,
      total_worker_rounds: 1,
      total_verify_rounds: 1,
      last_event: "goal_completed",
      last_classifier_verdict: "achieved",
      classifier_runs_attempted: 1,
      classifier_max_runs: 3,
    }));
    await this.#respondResult(request.id, {
      stopReason: "end_turn",
      _meta: { fixture: "goal-complete" },
    });
  }

  /**
   * Plan mode is read-only until the client approves the frozen plan. Real
   * Grok Build then resumes the same native tool loop and may start coding
   * before that original prompt reaches end_turn. Starting `/goal` remains a
   * separate client request used by Xora for supervised completion; this
   * fixture deliberately emits no Goal state during the approved Plan turn.
   */
  async #planPrompt(request: JsonRpcRequest, session: Session): Promise<void> {
    await this.#sessionUpdate(session.id, PLAN_MODE_FIXTURE);
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The read-only fixture plan is ready for approval." },
    });
    const approval = this.#requestClient("x.ai/exit_plan_mode", {
      sessionId: session.id,
      toolCallId: PLAN_APPROVAL_FIXTURE.toolCallId,
      planContent: PLAN_APPROVAL_FIXTURE.planContent,
    });
    const response = await approval.promise;
    const result = asRecord(response.result);
    if (response.error || result?.outcome !== "approved") {
      await this.#respondResult(request.id, {
        stopReason: "end_turn",
        _meta: { fixture: "plan-not-approved" },
      });
      return;
    }
    session.modeId = "default";
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "current_mode_update",
      currentModeId: session.modeId,
    });
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Approval received; applying the deterministic fixture edit." },
    });
    await this.#sessionUpdate(session.id, TOOL_CALL_FIXTURE);
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: TOOL_CALL_FIXTURE.toolCallId,
      status: "in_progress",
    });
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: TOOL_CALL_FIXTURE.toolCallId,
      status: "completed",
      rawOutput: { changedFiles: 1 },
      content: [DIFF_FIXTURE],
    });
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "plan",
      entries: PLAN_MODE_FIXTURE.entries.map((entry) => ({ ...entry, status: "completed" })),
    });
    await this.#sessionUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The approved fixture implementation is complete." },
    });
    await this.#respondResult(request.id, {
      stopReason: "end_turn",
      _meta: { fixture: "plan-approved" },
    });
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
    const reasoningEffort = asRecord(params?._meta)?.reasoningEffort;
    const target = asRecord(MODEL_STATE_FIXTURE.availableModels.find((model) => model.id === modelId));
    const targetMeta = asRecord(target?._meta);
    const options = targetMeta?.reasoningEfforts;
    const offered = Array.isArray(options)
      ? options.some(option => {
        const candidate = asRecord(option);
        return candidate?.id === reasoningEffort || candidate?.value === reasoningEffort;
      })
      : false;
    session.reasoningEffort = typeof reasoningEffort === "string" && offered
      ? reasoningEffort === "deep" ? "xhigh" : reasoningEffort
      : typeof targetMeta?.reasoningEffort === "string" ? targetMeta.reasoningEffort : undefined;
    await this.#respondResult(request.id, {});
    await this.#notifyModelState(sessionId, modelId, session.reasoningEffort);
  }

  async #setMode(request: JsonRpcRequest): Promise<void> {
    if (!await this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    const sessionId = params?.sessionId;
    const modeId = params?.modeId;
    if (typeof sessionId !== "string" || (modeId !== "default" && modeId !== "plan")) {
      await this.#respondError(request.id, INVALID_PARAMS, "session/set_mode requires a valid sessionId and modeId");
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      await this.#respondError(request.id, INVALID_SESSION, "Unknown session");
      return;
    }
    session.modeId = modeId;
    await this.#respondResult(request.id, {});
    await this.#sessionUpdate(sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    });
  }

  async #updateMcpServers(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = asRecord(request.params);
    const sessionId = params?.sessionId;
    const mcpServers = parseMcpServers(params?.mcpServers);
    if (typeof sessionId !== "string" || !mcpServers) {
      await this.#respondError(
        request.id,
        INVALID_PARAMS,
        "_x.ai/session/update_mcp_servers requires sessionId and valid mcpServers",
      );
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      await this.#respondError(request.id, INVALID_SESSION, "Unknown session");
      return;
    }

    // This extension replaces the complete client-provided MCP list. It is not
    // a delta operation, which keeps the fixture aligned with Grok Build.
    session.mcpServers = mcpServers;
    session.mcpState = mcpServers.length === 0 ? "ready" : "initializing";
    await this.#respondResult(request.id, { ok: true });
    await this.#notifyMcpInitializationStarted(session);
  }

  async #listMcpServers(request: JsonRpcRequest): Promise<void> {
    if (!this.#requireAuthenticated(request.id)) return;
    const params = request.params === undefined ? {} : asRecord(request.params);
    if (!params ||
        (params.sessionId !== undefined && typeof params.sessionId !== "string") ||
        (params.cache !== undefined && typeof params.cache !== "boolean")) {
      await this.#respondError(
        request.id,
        INVALID_PARAMS,
        "_x.ai/mcp/list accepts optional sessionId and cache parameters",
      );
      return;
    }

    const requestedSessionId = params.sessionId;
    const session = typeof requestedSessionId === "string"
      ? this.#sessions.get(requestedSessionId)
      : [...this.#sessions.values()].at(-1);
    if (typeof requestedSessionId === "string" && !session) {
      await this.#respondError(request.id, INVALID_SESSION, "Unknown session");
      return;
    }
    if (!session) {
      await this.#respondResult(request.id, { servers: [] });
      return;
    }

    const finishInitialization = session.mcpState === "initializing";
    await this.#respondResult(request.id, {
      servers: session.mcpServers.map((server) => mcpListItem(server, session.mcpState)),
    });

    // The first list response deliberately exposes `initializing`. Completing
    // immediately after that response makes readiness ordering deterministic
    // for contract tests without relying on timers or process scheduling.
    if (finishInitialization) await this.#completeMcpInitialization(session);
  }

  async #notifyMcpInitializationStarted(session: Session): Promise<void> {
    if (session.mcpServers.length === 0) {
      await this.#send({
        jsonrpc: "2.0",
        method: "_x.ai/mcp_initialized",
        params: { sessionId: session.id, mcpToolCount: 0, elapsedMs: 0 },
      });
      return;
    }
    await this.#send({
      jsonrpc: "2.0",
      method: "_x.ai/mcp/init_progress",
      params: { sessionId: session.id, total: session.mcpServers.length, connected: 0 },
    });
  }

  async #completeMcpInitialization(session: Session): Promise<void> {
    if (session.mcpState !== "initializing") return;
    session.mcpState = "ready";
    let toolCount = 0;
    for (const server of session.mcpServers) {
      const tools = [fixtureMcpTool(server.name)];
      toolCount += tools.length;
      await this.#send({
        jsonrpc: "2.0",
        method: "_x.ai/mcp/tools_changed",
        params: { sessionId: session.id, serverName: server.name, tools },
      });
      await this.#send({
        jsonrpc: "2.0",
        method: "_x.ai/mcp/server_status",
        params: {
          sessionId: session.id,
          name: server.name,
          source: "local",
          status: "ready",
          reason: "initialized",
          tools: null,
        },
      });
    }
    await this.#send({
      jsonrpc: "2.0",
      method: "_x.ai/mcp/init_progress",
      params: {
        sessionId: session.id,
        total: session.mcpServers.length,
        connected: session.mcpServers.length,
      },
    });
    await this.#send({
      jsonrpc: "2.0",
      method: "_x.ai/mcp_initialized",
      params: { sessionId: session.id, mcpToolCount: toolCount, elapsedMs: 1 },
    });
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

  async #notifyModelState(sessionId: string, currentModelId?: string, reasoningEffort?: string): Promise<void> {
    await this.#send({
      jsonrpc: "2.0",
      method: "_x.ai/model_state_updated",
      params: {
        sessionId,
        modelState: currentModelId
          ? modelState(currentModelId, reasoningEffort)
          : MODEL_STATE_FIXTURE,
      },
    });
  }

  async #notifyGoalState(sessionId: string, update: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#send({
      jsonrpc: "2.0",
      method: "x.ai/session_notification",
      params: { sessionId, update },
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

function modelState(currentModelId: string, reasoningEffort?: string): Record<string, unknown> {
  return {
    ...MODEL_STATE_FIXTURE,
    currentModelId,
    availableModels: MODEL_STATE_FIXTURE.availableModels.map(model => {
      const record = asRecord(model);
      const meta = asRecord(record?._meta);
      if (model.id !== currentModelId || !reasoningEffort || meta?.supportsReasoningEffort !== true) return model;
      return { ...model, _meta: { ...meta, reasoningEffort } };
    }),
  };
}

function textPrompt(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("\n");
}

function isGoalPrompt(text: string): boolean {
  return /^\s*\/goal(?:\s|$)/u.test(text);
}

function goalObjective(text: string): string {
  const objective = text.replace(/^\s*\/goal(?:\s+|$)/u, "").trim();
  return objective || GOAL_OBJECTIVE_FIXTURE;
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

function parseMcpServers(value: unknown): McpServerConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const servers: McpServerConfig[] = [];
  for (const item of value) {
    const server = asRecord(item);
    if (!server || !isNonEmptyString(server.name)) return undefined;
    const meta = server._meta === undefined ? undefined : asRecord(server._meta);
    if (server._meta !== undefined && !meta) return undefined;

    if (server.type === "http" || server.type === "sse") {
      const headers = parseNameValues(server.headers);
      if (!isNonEmptyString(server.url) || !headers) return undefined;
      servers.push({
        type: server.type,
        name: server.name,
        url: server.url,
        headers,
        ...(meta === undefined ? {} : { _meta: { ...meta } }),
      });
      continue;
    }

    // ACP stdio uses the absence of `type`; accepting `type: "stdio"` here
    // would hide a wire incompatibility with the pinned Grok Build schema.
    if (server.type !== undefined || !isNonEmptyString(server.command) ||
        !isStringArray(server.args)) return undefined;
    const env = parseNameValues(server.env);
    if (!env) return undefined;
    servers.push({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env,
      ...(meta === undefined ? {} : { _meta: { ...meta } }),
    });
  }
  return servers;
}

function parseNameValues(value: unknown): McpNameValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: McpNameValue[] = [];
  for (const item of value) {
    const pair = asRecord(item);
    if (!pair || !isNonEmptyString(pair.name) || typeof pair.value !== "string") return undefined;
    values.push({ name: pair.name, value: pair.value });
  }
  return values;
}

function mcpListItem(
  server: McpServerConfig,
  state: Session["mcpState"],
): Record<string, unknown> {
  const session = {
    enabled: true,
    status: state,
    tools: state === "ready" ? 1 : 0,
    authRequired: false,
    setupRequired: false,
  };
  if ("command" in server) {
    return {
      name: server.name,
      source: "local",
      type: "stdio",
      command: server.command,
      args: [...server.args],
      env: server.env.map((entry) => ({ ...entry })),
      session,
    };
  }
  return {
    name: server.name,
    source: "local",
    type: server.type,
    url: server.url,
    headers: server.headers.map((entry) => ({ ...entry })),
    session,
  };
}

function fixtureMcpTool(serverName: string): Record<string, unknown> {
  return {
    name: "fixture_tool",
    description: `Deterministic fixture tool for ${serverName}`,
    enabled: true,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
