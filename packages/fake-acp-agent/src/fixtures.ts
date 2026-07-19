export const FAKE_AGENT_VERSION = "0.2.103-fake";
export const FAKE_PROTOCOL_VERSION = 1;

export const MODEL_STATE_FIXTURE = Object.freeze({
  currentModelId: "grok",
  availableModels: Object.freeze([
    Object.freeze({
      id: "grok",
      name: "Grok (default)",
      description: "Deterministic fake of the Grok Build model alias",
    }),
    Object.freeze({
      id: "grok-4.5",
      name: "Grok 4.5",
      description: "Deterministic fake model for picker tests",
    }),
  ]),
});

export const PLAN_FIXTURE = Object.freeze({
  sessionUpdate: "plan",
  entries: Object.freeze([
    Object.freeze({ content: "Inspect the fixture project", priority: "high", status: "completed" }),
    Object.freeze({ content: "Apply the deterministic edit", priority: "high", status: "in_progress" }),
  ]),
});

export const TOOL_CALL_FIXTURE = Object.freeze({
  sessionUpdate: "tool_call",
  toolCallId: "fake-tool-0001",
  title: "Edit src/example.ts",
  kind: "edit",
  status: "pending",
  locations: Object.freeze([{ path: "src/example.ts", line: 1 }]),
  rawInput: Object.freeze({ path: "src/example.ts", replacement: "export const answer = 42;\n" }),
});

export const DIFF_FIXTURE = Object.freeze({
  type: "diff",
  path: "src/example.ts",
  oldText: "export const answer = 0;\n",
  newText: "export const answer = 42;\n",
});

export const PERMISSION_OPTIONS_FIXTURE = Object.freeze([
  Object.freeze({ optionId: "allow-once", name: "Allow once", kind: "allow_once" }),
  Object.freeze({ optionId: "allow-always", name: "Always allow", kind: "allow_always" }),
  Object.freeze({ optionId: "reject-once", name: "Reject", kind: "reject_once" }),
]);

export const AUTH_METHODS_FIXTURE = Object.freeze([
  Object.freeze({ id: "xai.api_key", name: "xAI API key", description: "Deterministic fake API-key auth" }),
  Object.freeze({ id: "grok.com", name: "Grok.com", description: "Deterministic fake subscription auth" }),
]);

export function sessionIdFixture(sequence: number): string {
  return `fake-session-${String(sequence).padStart(4, "0")}`;
}
