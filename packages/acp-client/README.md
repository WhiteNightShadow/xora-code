# `@grok-desktop/acp-client`

A small ACP/JSON-RPC 2.0 client for newline-delimited stdio transports. It does
not spawn or kill a process and never reads stderr: the desktop process owns the
Grok sidecar lifecycle and must pass only `child.stdout` to `consume()`.

```ts
import { AcpClient, createNodeWritableSink } from "@whitenight-code/acp-client";

const client = new AcpClient({ write: createNodeWritableSink(child.stdin) });
void client.consume(child.stdout);

client.onNotification("session/update", (params) => renderUpdate(params));
client.onRequest("session/request_permission", (params) => askUser(params));

const initialized = await client.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
});
```

Inbound lines and queued writes are bounded. Outbound request count is also
bounded. Cancellation is local unless a request supplies an ACP cancellation
notification, for example `{ method: "session/cancel", params: { sessionId } }`.
