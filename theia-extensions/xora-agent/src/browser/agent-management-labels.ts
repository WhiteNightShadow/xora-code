import type { RuntimeSnapshot } from '../common/agent-protocol';

export type AgentManagementTab = 'providers' | 'skills' | 'mcp' | 'plugins';

export type GrokSubscriptionAuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';

const TAB_LABELS: Record<AgentManagementTab, string> = {
    providers: '模型服务',
    skills: '技能',
    mcp: 'MCP',
    plugins: '插件'
};

const CHANNEL_LABELS = {
    stable: '稳定版',
    beta: '测试版',
    nightly: '每夜构建'
} as const;

export function managementTabLabel(tab: AgentManagementTab): string {
    return TAB_LABELS[tab];
}

export function credentialStatusLabel(configured: boolean | undefined): string {
    return configured ? '密钥已配置' : '未配置密钥';
}

/**
 * Derives only what the renderer can know without inspecting Grok's shared
 * credential files. A ready Grok subscription runtime proves that ACP
 * authentication completed in this window. All other runtime phases remain
 * unknown unless the user just completed an explicit login/logout action.
 */
export function grokSubscriptionAuthStatus(
    snapshot: Pick<RuntimeSnapshot, 'phase' | 'providerId'> & Partial<Pick<RuntimeSnapshot, 'grokSubscriptionAuthStatus'>> | undefined,
    lastKnown?: Exclude<GrokSubscriptionAuthStatus, 'unknown'>
): GrokSubscriptionAuthStatus {
    if (snapshot?.grokSubscriptionAuthStatus && snapshot.grokSubscriptionAuthStatus !== 'unknown') {
        return snapshot.grokSubscriptionAuthStatus;
    }
    if (snapshot?.providerId === 'grok-subscription' && snapshot.phase === 'ready') {
        return 'authenticated';
    }
    return lastKnown ?? 'unknown';
}

export function grokSubscriptionAuthStatusLabel(status: GrokSubscriptionAuthStatus): string {
    switch (status) {
        case 'authenticated': return '已登录';
        case 'unauthenticated': return '未登录';
        case 'unknown': return '登录状态待确认';
    }
}

export function componentChannelLabel(channel: keyof typeof CHANNEL_LABELS): string {
    return CHANNEL_LABELS[channel];
}

/** Empty password fields mean “keep the current credential”. */
export function optionalCredential(value: FormDataEntryValue | null): string | undefined {
    const credential = typeof value === 'string' ? value : '';
    return credential.length > 0 ? credential : undefined;
}
