/**
 * Engines a thread can run on (05 §4). The xora engine ships in the app bundle; external ACP agents are
 * launched from the user's PATH or through npx and keep their own login and subscription.
 */
export interface EngineDefinition {
    readonly id: string;
    readonly name: string;
    readonly kind: 'builtin' | 'external';
    /** External engines: the command and arguments that start an ACP server on stdio. */
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    /** Shown on approval cards when the agent cannot route its own actions through Xora's approvals. */
    readonly bypassesApprovals?: boolean;
    readonly homepage?: string;
    readonly note?: string;
}

export const XORA_ENGINE: EngineDefinition = { id: 'xora', name: 'Xora Engine', kind: 'builtin' };

/**
 * External ACP agents with known launch commands. Users can add their own; availability is detected when a
 * thread first starts one.
 */
export const EXTERNAL_ENGINES: readonly EngineDefinition[] = [
    {
        id: 'codex',
        name: 'Codex',
        kind: 'external',
        command: 'npx',
        args: ['-y', '@zed-industries/codex-acp'],
        homepage: 'https://github.com/zed-industries/codex-acp',
        note: '使用你自己的chatgpt登录',
    },
    {
        id: 'claude',
        name: 'Claude Code',
        kind: 'external',
        command: 'npx',
        args: ['-y', '@zed-industries/claude-code-acp'],
        homepage: 'https://github.com/zed-industries/claude-code-acp',
        note: '使用你自己的claude登录',
    },
    {
        id: 'gemini',
        name: 'Gemini CLI',
        kind: 'external',
        command: 'gemini',
        args: ['--experimental-acp'],
        homepage: 'https://github.com/google-gemini/gemini-cli',
    },
    {
        id: 'kimi',
        name: 'Kimi Code CLI',
        kind: 'external',
        command: 'kimi',
        args: ['acp'],
        homepage: 'https://github.com/MoonshotAI/kimi-cli',
        note: '使用kimi会员登录',
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        kind: 'external',
        command: 'opencode',
        args: ['acp'],
        homepage: 'https://github.com/anomalyco/opencode',
    },
    {
        id: 'qwen',
        name: 'Qwen Code',
        kind: 'external',
        command: 'qwen',
        args: ['--experimental-acp'],
        homepage: 'https://github.com/QwenLM/qwen-code',
    },
    {
        id: 'grok',
        name: 'Grok Build',
        kind: 'external',
        command: 'grok',
        args: ['acp'],
        homepage: 'https://www.npmjs.com/package/@xai-official/grok',
    },
];

export function engineById(id: string, custom: readonly EngineDefinition[] = []): EngineDefinition | undefined {
    if (id === XORA_ENGINE.id) {
        return XORA_ENGINE;
    }
    return [...custom, ...EXTERNAL_ENGINES].find((engine) => engine.id === id);
}
