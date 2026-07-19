/** JSON-compatible values accepted at runtime boundaries. */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RuntimeId = string;
export type IsoTimestamp = string;

export interface RuntimeEventBase {
  id: RuntimeId;
  sessionId: RuntimeId;
  timestamp: IsoTimestamp;
  /** Allows old readers to retain events introduced by a newer runtime. */
  metadata?: Record<string, JsonValue>;
}

export interface UserMessageEvent extends RuntimeEventBase {
  type: "message.user";
  content: string;
  attachments?: Array<{
    kind: "file" | "image" | "resource";
    name: string;
    uri: string;
    mediaType?: string;
  }>;
}

export interface AgentMessageEvent extends RuntimeEventBase {
  type: "message.agent";
  content: string;
  state: "delta" | "complete";
}

export type ToolKind =
  | "filesystem.read"
  | "filesystem.write"
  | "process.execute"
  | "network.request"
  | "mcp.call"
  | "browser.control"
  | "computer.control"
  | "other";

export interface ToolCallEvent extends RuntimeEventBase {
  type: "tool.call";
  callId: RuntimeId;
  toolKind: ToolKind;
  toolName: string;
  arguments: JsonValue;
}

export interface ToolResultEvent extends RuntimeEventBase {
  type: "tool.result";
  callId: RuntimeId;
  status: "success" | "error" | "cancelled";
  output?: JsonValue;
  error?: { code?: string; message: string };
}

export interface PermissionRequestEvent extends RuntimeEventBase {
  type: "permission.request";
  requestId: RuntimeId;
  subject: PolicySubject;
  explanation?: string;
}

export interface PermissionDecisionEvent extends RuntimeEventBase {
  type: "permission.decision";
  requestId: RuntimeId;
  decision: PolicyDecision;
  ruleIds: string[];
  decidedBy: "policy" | "user" | "host";
}

export interface PlanEvent extends RuntimeEventBase {
  type: "plan.changed";
  items: Array<{
    id: string;
    text: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

export interface DiffEvent extends RuntimeEventBase {
  type: "workspace.diff";
  path: string;
  unifiedDiff: string;
}

export interface TerminalEvent extends RuntimeEventBase {
  type: "terminal.output";
  terminalId: RuntimeId;
  stream: "stdout" | "stderr";
  data: string;
}

export interface UsageEvent extends RuntimeEventBase {
  type: "usage.changed";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface RuntimeErrorEvent extends RuntimeEventBase {
  type: "runtime.error";
  code: string;
  message: string;
  recoverable: boolean;
  details?: JsonValue;
}

export type RuntimeEvent =
  | UserMessageEvent
  | AgentMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionDecisionEvent
  | PlanEvent
  | DiffEvent
  | TerminalEvent
  | UsageEvent
  | RuntimeErrorEvent;

export type PolicyDecision = "allow" | "ask" | "deny";
export type PolicyRisk = "low" | "medium" | "high" | "critical";

export interface PolicySubject {
  operation: string;
  toolKind?: ToolKind;
  toolName?: string;
  path?: string;
  command?: { program: string; args: string[] };
  mcpServer?: string;
  networkHost?: string;
  risk?: PolicyRisk;
}

export interface PolicyContext {
  workspaceRoot?: string;
  sessionId?: string;
  providerProfileId?: string;
}

export interface PolicyRuleMatch {
  operations?: string[];
  toolKinds?: ToolKind[];
  toolNames?: string[];
  pathGlobs?: string[];
  commandGlobs?: string[];
  mcpServers?: string[];
  networkHosts?: string[];
  risks?: PolicyRisk[];
  workspaceGlobs?: string[];
  sessionIds?: string[];
  providerProfileIds?: string[];
}

export interface PolicyRule {
  id: string;
  effect: PolicyDecision;
  match: PolicyRuleMatch;
  reason?: string;
  enabled?: boolean;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  matchedRuleIds: string[];
  reason: string;
}

export type ProviderKind =
  | "xai"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "openai-compatible"
  | "custom";

export type ProviderApiBackend =
  | "responses"
  | "chat_completions"
  | "messages";

export type ProviderAuth =
  | { kind: "none" }
  | {
      kind: "api-key";
      /** Opaque identifier for the OS credential vault entry. Never the key itself. */
      secretRef: string;
      /** Environment variable injected only into the selected sidecar process. */
      envName: string;
    }
  | { kind: "oauth"; accountId?: string }
  | { kind: "subscription"; accountId?: string };

export interface ProviderCapabilities {
  vision?: boolean;
  toolUse?: boolean;
  reasoning?: boolean;
  backendSearch?: boolean;
  contextWindow?: number;
  maxCompletionTokens?: number;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  apiBackend: ProviderApiBackend;
  auth: ProviderAuth;
  description?: string;
  headers?: Record<string, string>;
  capabilities?: ProviderCapabilities;
}

export interface SessionRecord<TEvent = RuntimeEvent> {
  schemaVersion: 1;
  sessionId: string;
  sequence: number;
  timestamp: IsoTimestamp;
  event: TEvent;
}
