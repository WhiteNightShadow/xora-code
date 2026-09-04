export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * A write function for the agent's stdin. The string is one complete JSON-RPC
 * message including its trailing newline. The returned promise must settle only
 * after the transport has accepted the write; this is how write backpressure is
 * propagated into the client.
 */
export type AcpWrite = (line: string) => void | Promise<void>;

export type AcpInput = AsyncIterable<string | Uint8Array>;

export interface CancellationNotification {
  method: string;
  params?: unknown;
}

export type CancellationFactory =
  | CancellationNotification
  | ((id: JsonRpcId) => CancellationNotification);

export interface RequestOptions {
  /** A value of zero disables the timer for this request. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Optional wire-level cancellation. ACP prompt requests should normally use
   * `{ method: "session/cancel", params: { sessionId } }`.
   */
  cancellation?: CancellationFactory;
}

export interface RequestHandle<T> {
  readonly id: JsonRpcId;
  readonly promise: Promise<T>;
  /** Resolves after wire cancellation is delivered; rejects on transport failure. */
  cancel(reason?: unknown): Promise<void>;
}

export type NotificationHandler = (params: unknown, method: string) => void | Promise<void>;
export type RequestHandler = (params: unknown, method: string) => unknown | Promise<unknown>;
export type ErrorHandler = (error: Error) => void;

export interface AcpClientOptions {
  write: AcpWrite;
  /** Defaults to 30 seconds. Zero disables request timeouts by default. */
  defaultTimeoutMs?: number;
  /** Maximum UTF-8 byte length of one line, excluding CR/LF. Defaults to 1 MiB. */
  maxLineBytes?: number;
  /** Maximum number of unanswered outbound requests. Defaults to 1024. */
  maxPendingRequests?: number;
  /**
   * How long timed-out or cancelled request ids remain reserved so a late
   * response can be ignored safely. Defaults to 60 seconds. Zero disables
   * tombstones.
   */
  lateResponseTombstoneMs?: number;
  /** Maximum number of retained late-response tombstones. Defaults to 2048. */
  maxLateResponseTombstones?: number;
  /** Useful for deterministic tests; defaults to monotonically increasing integers. */
  createId?: () => JsonRpcId;
}
