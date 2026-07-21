/**
 * Converts known backend/ACP implementation errors into short Chinese UI
 * guidance. The original error remains available to the backend diagnostic
 * log; renderer notifications should explain the recovery action instead of
 * exposing lifecycle vocabulary such as Provider epochs or runtime restarts.
 */
export function friendlyAgentErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const normalized = message.trim();
    if (!normalized) return '操作未完成，请稍后重试。';

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
    if (/ACP session could not be restored|History remains read-only|history.*read-only/i.test(normalized)) {
        return '该会话暂时无法恢复，历史内容仍已保留。';
    }
    if (/Unknown Provider profile|(?:selected|globally selected) Provider no longer exists/i.test(normalized)) {
        return '所选模型服务已不存在，请在“账户与模型设置”中重新选择。';
    }
    return normalized;
}
