/**
 * Converts known backend/ACP implementation errors into short Chinese UI
 * guidance. The original error remains available to the backend diagnostic
 * log; renderer notifications should explain the recovery action instead of
 * exposing lifecycle vocabulary such as Provider epochs or runtime restarts.
 */
export function isTypedSessionNotFoundError(error: unknown): boolean {
    const candidate = error as { code?: unknown; message?: unknown } | undefined;
    if (candidate?.code === 'SESSION_NOT_FOUND') return true;
    const message = error instanceof Error
        ? error.message
        : typeof candidate?.message === 'string'
            ? candidate.message
            : String(error ?? '');
    return /^SESSION_NOT_FOUND(?::|\b)/i.test(message.trim());
}

export function isLegacyLocalSessionNotFoundError(error: unknown): boolean {
    const candidate = error as { message?: unknown } | undefined;
    const message = error instanceof Error
        ? error.message
        : typeof candidate?.message === 'string'
            ? candidate.message
            : String(error ?? '');
    return /^Unknown Xora Code session\.?$/i.test(message.trim());
}

export function isSessionNotFoundError(error: unknown): boolean {
    if (isTypedSessionNotFoundError(error)) return true;
    const candidate = error as { message?: unknown } | undefined;
    const message = error instanceof Error
        ? error.message
        : typeof candidate?.message === 'string'
            ? candidate.message
            : String(error ?? '');
    return isLegacyLocalSessionNotFoundError(error)
        || /^Unknown session(?::[^\r\n]*)?\.?$/i.test(message.trim());
}

function errorMessage(error: unknown): string {
    const candidate = error as { message?: unknown } | undefined;
    return error instanceof Error
        ? error.message
        : typeof candidate?.message === 'string'
            ? candidate.message
            : String(error ?? '');
}

function safeDiagnosticCode(code: unknown): string | undefined {
    if (typeof code !== 'string') return undefined;
    const normalized = code.trim().toUpperCase();
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(normalized) ? normalized : undefined;
}

const RUNTIME_DISCONNECT_PATTERN = /ACP stdout reached end of stream|Grok sidecar exited|sidecar (?:stopped|exited|crashed)|connection (?:closed|lost)|Failed to write to the ACP agent/i;
const WORKSPACE_BOUNDARY_PATTERN = /Agent changes must resolve to a file inside the trusted workspace|outside the trusted workspace|No trusted workspace is active/i;

/**
 * Stable, deliberately coarse error family used only for short-window UI
 * coalescing. One sidecar failure is often reported through several ACP
 * layers (PROMPT_FAILED -> stdout EOF -> SIDECAR_CRASHED); showing each layer
 * as a separate chat message makes a recoverable disconnect look like several
 * independent failures.
 */
export function agentErrorSemanticKey(code: unknown, message: unknown): string {
    const normalizedCode = safeDiagnosticCode(code) ?? 'UNKNOWN';
    const normalizedMessage = errorMessage(message).trim();
    if (normalizedCode === 'SIDECAR_CRASHED'
        || RUNTIME_DISCONNECT_PATTERN.test(normalizedMessage)) {
        return 'runtime-disconnected';
    }
    if (normalizedCode === 'PERMISSION_BOUNDARY_REJECTED'
        || WORKSPACE_BOUNDARY_PATTERN.test(normalizedMessage)) {
        return 'workspace-boundary';
    }
    if (isSessionNotFoundError({ code: normalizedCode, message: normalizedMessage })) {
        return 'session-missing';
    }
    if (normalizedCode === 'PROMPT_FAILED') return 'prompt-failed';
    if (normalizedCode === 'ACP_PROTOCOL_WARNING') return 'acp-protocol-warning';
    // Exact unknown diagnostics still coalesce, without accidentally merging
    // unrelated failures merely because they share a broad backend code.
    return `${normalizedCode}:${normalizedMessage.replace(/\s+/g, ' ').slice(0, 240)}`;
}

export function friendlyAgentErrorMessage(error: unknown): string {
    const message = errorMessage(error);
    const normalized = message.trim();
    if (!normalized) return '操作未完成，请稍后重试。';

    if (isSessionNotFoundError(error)) {
        return '原会话已失效。为避免重复执行，任务未自动重发；内容已保留，可在新会话中重试。';
    }
    if (/Restart the runtime for the selected workspace and Provider first|active runtime has no coherent Provider epoch|Provider changed after (?:this runtime|the session) (?:was )?(?:started|created)|active runtime does not match this session/i.test(normalized)) {
        return '模型服务刚刚发生变化，Xora Code 正在重新连接，请稍后重新发送。';
    }
    if (/STALE_PROVIDER_SELECTION|application-wide (?:Provider|model service|model) changed|selected conversation is not the active global Provider session/i.test(normalized)) {
        return '当前模型服务已更新，请稍后重新发送。';
    }
    if (/No credential is available|provider needs an API key|This provider needs an API key|needs an API key/i.test(normalized)) {
        return '当前模型服务没有可用的 API 密钥，请在“账户与模型设置”中重新保存密钥。';
    }
    if (/Unauthorized|INVALID_API_KEY|\b401\b/i.test(normalized)) {
        return 'API 密钥无效，或中转站拒绝了请求（401）。请检查 Base URL、API 密钥和模型 ID。';
    }
    if (/model is not advertised by (?:this|the) ACP runtime|selected model is not advertised|newly selected global model is not advertised/i.test(normalized)) {
        return '当前 Grok Build 未识别所选模型，请检查模型 ID 后重新保存。';
    }
    if (/requested Agent mode is not advertised by this session/i.test(normalized)) {
        return '当前会话不支持该执行方式，请使用“常规”或“持续完成”。';
    }
    if (/ACP session could not be restored|History remains read-only|history.*read-only/i.test(normalized)) {
        return '该会话暂时无法恢复，历史内容仍已保留。';
    }
    if (RUNTIME_DISCONNECT_PATTERN.test(normalized)) {
        return 'Agent 连接已中断，Xora Code 正在安全恢复；未确认的任务不会自动重发。';
    }
    if (WORKSPACE_BOUNDARY_PATTERN.test(normalized)) {
        return '目标文件不在当前允许访问的范围内，本次操作已被阻止。请打开对应目录或调整访问范围后重试。';
    }
    if (/Unknown Provider profile|(?:selected|globally selected) Provider no longer exists/i.test(normalized)) {
        return '所选模型服务已不存在，请在“账户与模型设置”中重新选择。';
    }
    return normalized;
}

/** Friendly renderer text for a typed host error. The machine-readable code
 * remains visible for support diagnostics, while known implementation details
 * are translated into a short recovery instruction. */
export function friendlyAgentEventErrorMessage(code: unknown, message: unknown): string {
    const diagnosticCode = safeDiagnosticCode(code);
    let friendly = friendlyAgentErrorMessage(message);
    if (friendly === errorMessage(message).trim()) {
        if (diagnosticCode === 'SIDECAR_CRASHED') {
            friendly = 'Agent 连接已中断，Xora Code 正在安全恢复；未确认的任务不会自动重发。';
        } else if (diagnosticCode === 'PROMPT_FAILED') {
            friendly = '任务执行未完成，原消息已保留，可在连接恢复后重试。';
        } else if (diagnosticCode === 'ACP_PROTOCOL_WARNING') {
            friendly = 'Agent 通信出现异常，Xora Code 将继续尝试恢复。';
        } else if (diagnosticCode === 'PERMISSION_BOUNDARY_REJECTED') {
            friendly = '目标文件不在当前允许访问的范围内，本次操作已被阻止。请打开对应目录或调整访问范围后重试。';
        }
    }
    return diagnosticCode ? `${friendly} [${diagnosticCode}]` : friendly;
}
