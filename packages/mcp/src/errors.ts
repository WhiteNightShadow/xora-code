export type McpErrorCode =
    | 'invalid-config'
    | 'spawn-failed'
    | 'connect-failed'
    | 'unauthorized'
    | 'timeout'
    | 'aborted'
    | 'closed'
    | 'not-running'
    | 'tool-not-found'
    | 'tool-not-allowed'
    | 'protocol'
    | 'oauth';

/**
 * Every error this package throws. Messages are already redacted, and the original error is deliberately not kept
 * as `cause`: SDK errors can carry raw HTTP bodies, headers or URLs with credentials in them.
 */
export class McpError extends Error {
    readonly code: McpErrorCode;
    /** JSON-RPC error code, when the server answered a request with an error. */
    readonly rpcCode: number | undefined;

    constructor(code: McpErrorCode, message: string, rpcCode?: number) {
        super(message);
        this.name = 'McpError';
        this.code = code;
        this.rpcCode = rpcCode;
    }
}

export function isAbortError(error: unknown): boolean {
    return (
        error instanceof Error && (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR')
    );
}

/** The message, plus the error code or message of its cause (`fetch failed (ECONNREFUSED)`). */
export function errorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const message = error.message || error.name;
    const cause = (error as { cause?: unknown }).cause;
    if (typeof cause !== 'object' || cause === null) {
        return message;
    }
    const code = (cause as { code?: unknown }).code;
    const detail = typeof code === 'string' ? code : cause instanceof Error ? cause.message : undefined;
    return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}
