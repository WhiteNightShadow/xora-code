# `@xora-code/fake-acp-agent`

A deterministic ACP v1 agent for desktop integration tests. It speaks one
JSON-RPC 2.0 object per stdin/stdout line and never writes diagnostics to
stdout.

The normal flow is `initialize` → `authenticate` → `session/new` (or
`session/load`) → `session/prompt`. Every prompt emits fixed model-state, plan,
text, tool-call, permission-request, diff and completion fixtures. Reply to the
`session/request_permission` request with:

```json
{"outcome":{"outcome":"selected","optionId":"allow-once"}}
```

Sending a `session/cancel` notification while permission is pending makes the
original prompt finish with `{ "stopReason": "cancelled" }`.

The session also advertises the native `/goal` command and `update_goal` tool.
A prompt beginning with `/goal` emits deterministic
`x.ai/session_notification` / `goal_updated` transitions, including an active
verification state after a cosmetic all-completed Plan snapshot. Ordinary
prompts emit no Goal lifecycle events.

`session/set_mode` accepts `default` and `plan`. A prompt in Plan mode performs
no edits before sending an `x.ai/exit_plan_mode` reverse request. Reply with
`{ "outcome": "approved" }` to switch back to `default`; the same native loop
then emits a deterministic edit and diff before finishing with `end_turn`.
This intentionally matches Grok Build: approval can resume coding, but does not
start Goal by itself. The client must send one subsequent `/goal …` prompt to
continue the approved objective under Goal supervision and verification.
