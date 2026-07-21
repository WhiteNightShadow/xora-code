import {
  AcpCancelledError,
  AcpCapacityError,
  AcpConnectionClosedError,
  AcpParseError,
  AcpProtocolError,
  AcpRemoteError,
  AcpRequestHandlerError,
  AcpTimeoutError,
  AcpUnknownResponseError,
  AcpWriteError,
} from "./errors.js";
import { NdjsonLineDecoder } from "./line-decoder.js";
import type {
  AcpClientOptions,
  AcpInput,
  CancellationFactory,
  CancellationNotification,
  ErrorHandler,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  NotificationHandler,
  RequestHandle,
  RequestHandler,
  RequestOptions,
} from "./types.js";

interface PendingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancellation?: CancellationFactory;
  readonly abortSignal?: AbortSignal;
  readonly abortHandler?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING = 1024;
const ANY_METHOD = "*";

export class AcpClient {
  readonly #write;
  readonly #defaultTimeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #maxPendingRequests: number;
  readonly #createId: () => JsonRpcId;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #notificationHandlers = new Map<string, Set<NotificationHandler>>();
  readonly #requestHandlers = new Map<string, RequestHandler>();
  readonly #errorHandlers = new Set<ErrorHandler>();
  #nextId = 1;
  #writeTail: Promise<void> = Promise.resolve();
  #closedError: AcpConnectionClosedError | AcpWriteError | undefined;
  #consumeStarted = false;

  constructor(options: AcpClientOptions) {
    if (typeof options.write !== "function") throw new TypeError("write must be a function");
    this.#write = options.write;
    this.#defaultTimeoutMs = validateNonNegativeInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.#maxLineBytes = validatePositiveInteger(
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      "maxLineBytes",
    );
    this.#maxPendingRequests = validatePositiveInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING,
      "maxPendingRequests",
    );
    this.#createId = options.createId ?? (() => this.#nextId++);
  }

  get closed(): boolean {
    return this.#closedError !== undefined;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  async consume(input: AcpInput): Promise<void> {
    if (this.#consumeStarted) throw new AcpProtocolError("consume() may only be called once");
    if (this.#closedError) throw this.#closedError;
    this.#consumeStarted = true;
    const decoder = new NdjsonLineDecoder(this.#maxLineBytes);

    try {
      for await (const chunk of input) {
        for (const line of decoder.push(chunk)) this.#routeLine(line);
      }
      for (const line of decoder.finish()) this.#routeLine(line);
      this.close(new AcpConnectionClosedError("ACP stdout reached end of stream"));
    } catch (cause) {
      const error = cause instanceof Error
        ? cause
        : new AcpProtocolError("ACP input failed", { cause });
      this.close(error);
      throw error;
    }
  }

  async request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    return this.startRequest<T>(method, params, options).promise;
  }

  startRequest<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): RequestHandle<T> {
    assertMethod(method);
    this.#throwIfClosed();
    if (this.#pending.size >= this.#maxPendingRequests) {
      throw new AcpCapacityError(this.#maxPendingRequests);
    }
    if (options.signal?.aborted) {
      const id = this.#createId();
      const error = new AcpCancelledError(id, method, options.signal.reason);
      return { id, promise: Promise.reject(error), cancel: async () => undefined };
    }

    const id = this.#createId();
    assertId(id);
    if (this.#pending.has(id)) throw new AcpProtocolError(`createId() returned duplicate id ${String(id)}`);
    const timeoutMs = validateNonNegativeInteger(
      options.timeoutMs ?? this.#defaultTimeoutMs,
      "timeoutMs",
    );

    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const pending: PendingRequest = {
      id,
      method,
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
      ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    };
    this.#pending.set(id, pending);

    if (timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        void this.#cancelPending(pending, new AcpTimeoutError(id, method, timeoutMs));
      }, timeoutMs);
      pending.timer.unref?.();
    }

    if (options.signal) {
      const abortHandler = () => {
        void this.#cancelPending(pending, new AcpCancelledError(id, method, options.signal?.reason));
      };
      (pending as { abortHandler?: () => void }).abortHandler = abortHandler;
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    void this.#send(message).catch((error: Error) => this.#rejectPending(id, error));

    return {
      id,
      promise,
      cancel: (reason?: unknown) => this.#cancelPending(
        pending,
        new AcpCancelledError(id, method, reason),
      ),
    };
  }

  async notify(method: string, params?: unknown): Promise<void> {
    assertMethod(method);
    this.#throwIfClosed();
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    await this.#send(message);
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    assertSubscriptionMethod(method);
    let handlers = this.#notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) this.#notificationHandlers.delete(method);
    };
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    assertMethod(method);
    this.#requestHandlers.set(method, handler);
    return () => {
      if (this.#requestHandlers.get(method) === handler) this.#requestHandlers.delete(method);
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  /** Waits until every previously queued write has either completed or failed. */
  async drain(): Promise<void> {
    await this.#writeTail;
  }

  /** Reject pending calls. Process lifetime and stderr remain the caller's concern. */
  close(reason?: unknown): void {
    if (this.#closedError) return;
    const error = reason instanceof AcpWriteError || reason instanceof AcpConnectionClosedError
      ? reason
      : new AcpConnectionClosedError(
        reason instanceof Error ? reason.message : "ACP connection closed",
        reason instanceof Error ? { cause: reason } : undefined,
      );
    this.#closedError = error;
    for (const pending of [...this.#pending.values()]) this.#rejectPending(pending.id, error);
  }

  #routeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new AcpParseError("Invalid JSON in ACP stdout", previewLine(line), { cause });
    }
    const message = validateMessage(parsed, line);
    if (isResponse(message)) {
      this.#handleResponse(message);
    } else if ("id" in message) {
      void this.#handleInboundRequest(message);
    } else {
      this.#handleNotification(message);
    }
  }

  #handleResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      // Grok Build / Grok CLI may emit extension lifecycle acknowledgements
      // (for example `skills-reload` after login) as response-shaped messages
      // whose string ids were never issued by this client. Treat those as
      // best-effort notifications so a concurrent CLI login cannot surface as
      // a protocol hard-failure in the desktop host.
      if (typeof response.id === "string" && !/^\d+$/.test(response.id)) {
        const params = "result" in response
          ? response.result
          : { error: (response as { error?: unknown }).error };
        this.#handleNotification({
          jsonrpc: "2.0",
          method: response.id,
          ...(params === undefined ? {} : { params }),
        });
        return;
      }
      this.#emitError(new AcpUnknownResponseError(response.id));
      return;
    }
    this.#cleanupPending(pending);
    if ("error" in response) pending.reject(new AcpRemoteError(response.id, pending.method, response.error));
    else pending.resolve(response.result);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    const handlers = [
      ...(this.#notificationHandlers.get(notification.method) ?? []),
      ...(this.#notificationHandlers.get(ANY_METHOD) ?? []),
    ];
    for (const handler of handlers) {
      Promise.resolve()
        .then(() => handler(notification.params, notification.method))
        .catch((cause) => this.#emitError(asError(cause, `Notification handler failed: ${notification.method}`)));
    }
  }

  async #handleInboundRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.#requestHandlers.get(request.method);
    if (!handler) {
      await this.#sendErrorResponse(request.id, -32601, `Method not found: ${request.method}`);
      return;
    }

    try {
      const result = await handler(request.params, request.method);
      await this.#send({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
    } catch (cause) {
      if (cause instanceof AcpRequestHandlerError) {
        await this.#sendErrorResponse(request.id, cause.rpcCode, cause.message, cause.data);
      } else {
        this.#emitError(asError(cause, `Request handler failed: ${request.method}`));
        await this.#sendErrorResponse(request.id, -32603, "Internal error");
      }
    }
  }

  async #sendErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    const error: JsonRpcErrorObject = { code, message, ...(data === undefined ? {} : { data }) };
    try {
      await this.#send({ jsonrpc: "2.0", id, error });
    } catch (cause) {
      this.#emitError(asError(cause, "Failed to send JSON-RPC error response"));
    }
  }

  #send(message: JsonRpcMessage): Promise<void> {
    this.#throwIfClosed();
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (cause) {
      return Promise.reject(new AcpProtocolError("JSON-RPC message is not serializable", { cause }));
    }

    const write = this.#writeTail.then(async () => {
      this.#throwIfClosed();
      try {
        await this.#write(line);
      } catch (cause) {
        const error = new AcpWriteError({ cause });
        this.#failWrite(error);
        throw error;
      }
    });
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  #failWrite(error: AcpWriteError): void {
    if (this.#closedError) return;
    this.#closedError = error;
    for (const pending of [...this.#pending.values()]) this.#rejectPending(pending.id, error);
    this.#emitError(error);
  }

  async #cancelPending(pending: PendingRequest, error: AcpCancelledError | AcpTimeoutError): Promise<void> {
    if (this.#pending.get(pending.id) !== pending) return;
    this.#cleanupPending(pending);
    pending.reject(error);
    if (!pending.cancellation || this.#closedError) return;
    const notification = resolveCancellation(pending.cancellation, pending.id);
    try {
      await this.notify(notification.method, notification.params);
    } catch (cause) {
      this.#emitError(asError(cause, `Failed to send cancellation for ${pending.method}`));
    }
  }

  #rejectPending(id: JsonRpcId, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#cleanupPending(pending);
    pending.reject(error);
  }

  #cleanupPending(pending: PendingRequest): void {
    this.#pending.delete(pending.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
    }
  }

  #throwIfClosed(): void {
    if (this.#closedError) throw this.#closedError;
  }

  #emitError(error: Error): void {
    for (const handler of this.#errorHandlers) {
      try {
        handler(error);
      } catch {
        // Error observers must never destabilize protocol routing.
      }
    }
  }
}

function resolveCancellation(factory: CancellationFactory, id: JsonRpcId): CancellationNotification {
  const result = typeof factory === "function" ? factory(id) : factory;
  assertMethod(result.method);
  return result;
}

function validateMessage(value: unknown, line: string): JsonRpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new AcpProtocolError(`ACP line is not a JSON-RPC 2.0 message: ${previewLine(line)}`);
  }
  const hasMethod = Object.prototype.hasOwnProperty.call(value, "method");
  const hasId = Object.prototype.hasOwnProperty.call(value, "id");
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");

  if (hasMethod) {
    if (typeof value.method !== "string" || value.method.length === 0 || hasResult || hasError) {
      throw new AcpProtocolError(`Malformed JSON-RPC request/notification: ${previewLine(line)}`);
    }
    if (hasId) assertId(value.id);
    return value as unknown as JsonRpcRequest | JsonRpcNotification;
  }

  if (!hasId || hasResult === hasError) {
    throw new AcpProtocolError(`Malformed JSON-RPC response: ${previewLine(line)}`);
  }
  assertId(value.id);
  if (hasError && !isJsonRpcError(value.error)) {
    throw new AcpProtocolError(`Malformed JSON-RPC error object: ${previewLine(line)}`);
  }
  return value as unknown as JsonRpcResponse;
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message);
}

function isJsonRpcError(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value) && Number.isInteger(value.code) && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertMethod(method: string): void {
  if (typeof method !== "string" || method.length === 0) throw new TypeError("method must be a non-empty string");
}

function assertSubscriptionMethod(method: string): void {
  if (method !== ANY_METHOD) assertMethod(method);
}

function assertId(id: unknown): asserts id is JsonRpcId {
  if ((typeof id !== "string" || id.length === 0) &&
      (typeof id !== "number" || !Number.isSafeInteger(id))) {
    throw new AcpProtocolError("JSON-RPC id must be a non-empty string or safe integer");
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function previewLine(line: string): string {
  return line.length <= 160 ? line : `${line.slice(0, 160)}…`;
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback, { cause });
}
