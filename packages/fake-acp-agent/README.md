# `@grok-desktop/fake-acp-agent`

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
