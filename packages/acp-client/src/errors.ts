import type { JsonRpcErrorObject, JsonRpcId } from "./types.js";

export class AcpClientError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.kind = kind;
  }
}

export class AcpProtocolError extends AcpClientError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol", message, options);
  }
}

export class AcpParseError extends AcpProtocolError {
  readonly linePreview: string;

  constructor(message: string, linePreview: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpParseError";
    this.linePreview = linePreview;
  }
}

export class AcpLineTooLongError extends AcpProtocolError {
  readonly limit: number;
  readonly actual: number;

  constructor(limit: number, actual: number) {
    super(`ACP JSON-RPC line is ${actual} bytes; the configured limit is ${limit}`);
    this.name = "AcpLineTooLongError";
    this.limit = limit;
    this.actual = actual;
  }
}

export class AcpRemoteError extends AcpClientError {
  readonly rpcCode: number;
  readonly data: unknown;
  readonly requestId: JsonRpcId;
  readonly method: string;

  constructor(requestId: JsonRpcId, method: string, error: JsonRpcErrorObject) {
    super("remote", `${method} failed (${error.code}): ${error.message}`);
    this.rpcCode = error.code;
    this.data = error.data;
    this.requestId = requestId;
    this.method = method;
  }
}

export class AcpTimeoutError extends AcpClientError {
  readonly requestId: JsonRpcId;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(requestId: JsonRpcId, method: string, timeoutMs: number) {
    super("timeout", `${method} timed out after ${timeoutMs}ms`);
    this.requestId = requestId;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AcpCancelledError extends AcpClientError {
  readonly requestId: JsonRpcId;
  readonly method: string;
  readonly reason: unknown;

  constructor(requestId: JsonRpcId, method: string, reason?: unknown) {
    super("cancelled", `${method} was cancelled`, reason instanceof Error ? { cause: reason } : undefined);
    this.requestId = requestId;
    this.method = method;
    this.reason = reason;
  }
}

export class AcpConnectionClosedError extends AcpClientError {
  constructor(message = "ACP connection closed", options?: ErrorOptions) {
    super("connection_closed", message, options);
  }
}

export class AcpWriteError extends AcpClientError {
  constructor(options?: ErrorOptions) {
    super("write", "Failed to write to the ACP agent", options);
  }
}

export class AcpCapacityError extends AcpClientError {
  readonly limit: number;

  constructor(limit: number) {
    super("capacity", `ACP client already has ${limit} pending requests`);
    this.limit = limit;
  }
}

export class AcpUnknownResponseError extends AcpProtocolError {
  readonly requestId: JsonRpcId;

  constructor(requestId: JsonRpcId) {
    super(`Received a response for unknown request id ${JSON.stringify(requestId)}`);
    this.name = "AcpUnknownResponseError";
    this.requestId = requestId;
  }
}

/** Throw from an inbound request handler to control its JSON-RPC error response. */
export class AcpRequestHandlerError extends AcpClientError {
  readonly rpcCode: number;
  readonly data: unknown;

  constructor(rpcCode: number, message: string, data?: unknown) {
    super("request_handler", message);
    this.rpcCode = rpcCode;
    this.data = data;
  }
}
