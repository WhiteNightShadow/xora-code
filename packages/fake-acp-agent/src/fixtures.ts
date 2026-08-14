export const FAKE_AGENT_VERSION = "0.2.103-fake";
export const FAKE_PROTOCOL_VERSION = 1;

export const MODEL_STATE_FIXTURE = Object.freeze({
  currentModelId: "grok",
  availableModels: Object.freeze([
    Object.freeze({
      id: "grok",
      name: "Grok (default)",
      description: "Deterministic fake of the Grok Build model alias",
      _meta: Object.freeze({
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: Object.freeze([
          Object.freeze({ id: "low", value: "low", label: "Low" }),
          Object.freeze({ id: "high", value: "high", label: "High", description: "Fixture default" }),
          Object.freeze({ id: "deep", value: "xhigh", label: "Deep" }),
        ]),
      }),
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

/**
 * Grok Build advertises slash commands through ACP session updates rather
 * than through a pager-only command registry.  Keep this fixture deliberately
 * small: contract tests only need to prove that clients discover `/goal` from
 * the live session instead of inferring support from a version string.
 */
export const AVAILABLE_COMMANDS_FIXTURE = Object.freeze({
  sessionUpdate: "available_commands_update",
  availableCommands: Object.freeze([
    Object.freeze({
      name: "goal",
      description: "Start or manage a persistent goal",
      input: Object.freeze({ hint: "<objective> | status | pause | resume | clear" }),
    }),
  ]),
  _meta: Object.freeze({ tools: Object.freeze(["update_goal"]) }),
});

export const PLAN_MODE_FIXTURE = Object.freeze({
  sessionUpdate: "plan",
  entries: Object.freeze([
    Object.freeze({
      id: "fixture-plan-1",
      content: "Inspect the project without modifying files",
      priority: "high",
      status: "completed",
    }),
    Object.freeze({
      id: "fixture-plan-2",
      content: "Implement the approved change and run the fixture test",
      priority: "high",
      status: "pending",
    }),
  ]),
});

export const PLAN_APPROVAL_FIXTURE = Object.freeze({
  toolCallId: "fake-exit-plan-0001",
  planContent: [
    "# Fixture plan",
    "",
    "## Goal",
    "Implement the requested deterministic fixture change.",
    "",
    "## Acceptance criteria",
    "- Apply the fixture edit.",
    "- Run the fixture validation.",
  ].join("\n"),
});

export const GOAL_OBJECTIVE_FIXTURE = "Implement the requested deterministic fixture change";

export function goalUpdateFixture(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    sessionUpdate: "goal_updated",
    goal_id: "fake-goal-0001",
    objective: GOAL_OBJECTIVE_FIXTURE,
    status: "active",
    phase: "executing",
    token_budget: 100_000,
    tokens_used: 1_000,
    elapsed_ms: 250,
    total_deliverables: 0,
    completed_deliverables: 0,
    total_worker_rounds: 1,
    total_verify_rounds: 0,
    token_baseline: 0,
    finished_subagent_tokens: 0,
    ...overrides,
  });
}

export const TOOL_CALL_FIXTURE = Object.freeze({
  sessionUpdate: "tool_call",
  toolCallId: "fake-tool-0001",
  title: "Edit src/example.ts",
  kind: "edit",
  status: "pending",
  locations: Object.freeze([{ path: "src/example.ts", line: 1 }]),
  rawInput: Object.freeze({ path: "src/example.ts", replacement: "export const answer = 42;\n" }),
  _meta: Object.freeze({
    "x.ai/tool": Object.freeze({
      version: 1,
      name: "search_replace",
      kind: "edit",
      namespace: "grok_build",
      label: "Edit",
      read_only: false,
      input: Object.freeze({ path: "src/example.ts" }),
    }),
  }),
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
