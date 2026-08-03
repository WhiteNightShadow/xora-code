const assert = require('node:assert/strict');
const test = require('node:test');

const {
    displayToolTitle,
    isGoalCompletionRequest,
    isMachineToolTitle,
    presentAgentTool,
    sessionRelativeTime,
    sessionStatusLabel,
    summarizeAgentContext,
    summarizeToolCategories,
    toolMatchesActivityFilter
} = require('../lib/browser/agent-display-helpers');

test('native Goal completion requests are a verification hint, not a verified result', () => {
    assert.equal(isGoalCompletionRequest({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'goal-1',
        title: 'Goal: marking complete',
        toolName: 'update_goal',
        toolKind: 'goal_update',
        status: 'completed',
        input: { completed: true }
    }), true);
    assert.equal(isGoalCompletionRequest({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'goal-2',
        title: 'Goal: progress',
        toolName: 'update_goal',
        toolKind: 'goal_update',
        status: 'completed',
        input: { message: 'still working' }
    }), false);
    assert.equal(isGoalCompletionRequest(undefined), false);
});

test('machine tool titles are recognized and replaced with safe Chinese labels', () => {
    assert.equal(isMachineToolTitle('call-20b15043-5d26-433c-8bd5-556a812f7381'), true);
    assert.equal(isMachineToolTitle('fake-tool-0001', 'fake-tool-0001'), true);
    assert.equal(isMachineToolTitle('读取项目清单'), false);

    const fileTitle = displayToolTitle({
        title: 'call-20b15043-5d26-433c-8bd5-556a812f7381',
        toolCallId: 'call-20b15043-5d26-433c-8bd5-556a812f7381',
        toolName: 'filesystem/read_file',
        input: { path: '/Users/private/project/src/example.ts', apiKey: 'must-not-appear' }
    });
    assert.equal(fileTitle, '读取文件 · example.ts');
    assert.doesNotMatch(fileTitle, /Users|private|api|must-not-appear/i);

    const terminalTitle = displayToolTitle({
        title: 'curl https://token@example.test',
        toolCallId: 'tool-2',
        toolName: 'terminal/execute_command',
        input: { command: 'curl -H "Authorization: Bearer secret" https://example.test' }
    });
    assert.equal(terminalTitle, '运行命令');
    assert.doesNotMatch(terminalTitle, /curl|secret|example/i);

    assert.equal(displayToolTitle({
        title: 'call-3',
        toolCallId: 'call-3',
        toolName: 'filesystem/read_directory',
        input: { path: 'C:\\workspace\\project' }
    }), '查看目录 · project');
    assert.equal(displayToolTitle({
        title: 'opaque title',
        toolCallId: 'tool-4',
        toolName: 'vendor/custom_tool',
        input: { token: 'secret' }
    }), '执行工具');
    assert.equal(displayToolTitle({
        title: 'call-5',
        toolCallId: 'call-5',
        toolName: 'tool',
        input: { path: '/private/project/package.json' }
    }), '处理文件 · package.json');
    assert.equal(displayToolTitle({
        title: 'call-6',
        toolCallId: 'call-6',
        toolName: 'tool',
        input: { command: 'echo super-secret' }
    }), '运行命令');
});

test('structured tool metadata produces distinct action and source labels', () => {
    const file = {
        title: 'read_file', toolCallId: 'file-1', toolName: 'read_file', toolKind: 'read',
        presentation: { action: 'file-read', source: 'builtin', targetLabel: 'agent.tsx', readOnly: true }
    };
    const web = {
        title: 'web_search', toolCallId: 'web-1', toolName: 'web_search', toolKind: 'web_search',
        presentation: { action: 'web-search', source: 'builtin', targetLabel: 'Electron safeStorage' }
    };
    const skill = {
        title: 'skill', toolCallId: 'skill-1', toolName: 'skill', toolKind: 'skill',
        presentation: { action: 'other', source: 'skill', sourceLabel: 'ui-review' }
    };
    const mcp = {
        title: 'github__create_issue', toolCallId: 'mcp-1', toolName: 'github__create_issue', toolKind: 'other',
        presentation: { action: 'other', source: 'mcp', sourceLabel: 'GitHub', operationLabel: 'create_issue' }
    };
    const plugin = {
        title: 'plugin_update', toolCallId: 'plugin-1', toolName: 'plugin_update', toolKind: 'other',
        presentation: { action: 'other', source: 'plugin', sourceLabel: 'team-tools' }
    };

    assert.deepEqual(presentAgentTool(file), {
        action: 'file-read', source: 'builtin', filter: 'files', badgeLabel: '文件',
        title: '读取文件 · agent.tsx', detailLabel: '只读操作', iconClass: 'codicon-file', tone: 'file', readOnly: true
    });
    assert.equal(presentAgentTool(web).badgeLabel, '网络');
    assert.equal(presentAgentTool(web).title, '搜索互联网 · Electron safeStorage');
    assert.equal(presentAgentTool(skill).title, 'ui-review');
    assert.equal(presentAgentTool(skill).filter, 'skill');
    assert.equal(presentAgentTool(mcp).title, 'GitHub · create_issue');
    assert.equal(presentAgentTool(mcp).filter, 'mcp');
    assert.equal(presentAgentTool(plugin).title, 'team-tools');
    assert.equal(presentAgentTool(plugin).filter, 'plugin');
    assert.equal(toolMatchesActivityFilter(mcp, 'mcp'), true);
    assert.equal(toolMatchesActivityFilter(mcp, 'files'), false);
    assert.deepEqual(summarizeToolCategories([file, web, mcp, file]), [
        { filter: 'files', label: '文件', count: 2 },
        { filter: 'web', label: '网络', count: 1 },
        { filter: 'mcp', label: 'MCP', count: 1 }
    ]);
});

test('file creation keeps its own visible action in canonical and legacy records', () => {
    const canonical = presentAgentTool({
        toolCallId: 'create-1',
        toolName: 'create_file',
        presentation: { action: 'file-create', source: 'builtin', targetLabel: 'new-agent.ts' }
    });
    assert.equal(canonical.title, '创建文件 · new-agent.ts');
    assert.equal(canonical.filter, 'files');

    const legacy = presentAgentTool({
        toolCallId: 'create-legacy',
        toolName: 'create_file',
        toolKind: 'create',
        input: { path: '/private/project/new-agent.ts' }
    });
    assert.equal(legacy.action, 'file-create');
    assert.equal(legacy.title, '创建文件 · new-agent.ts');
});

test('legacy tool records remain categorized without exposing sensitive commands or URLs', () => {
    const terminal = presentAgentTool({
        title: 'curl https://token@example.test',
        toolCallId: 'legacy-terminal',
        toolName: 'terminal/execute_command',
        input: { command: 'curl -H "Authorization: Bearer secret" https://example.test' }
    });
    assert.equal(terminal.filter, 'terminal');
    assert.equal(terminal.title, '运行命令');
    assert.doesNotMatch(JSON.stringify(terminal), /curl|secret|example/i);

    const web = presentAgentTool({
        title: 'web_search',
        toolCallId: 'legacy-web',
        toolName: 'web_search',
        toolKind: 'web_search',
        input: { query: 'Agent activity UI' }
    });
    assert.equal(web.filter, 'web');
    assert.equal(web.title, '搜索互联网 · Agent activity UI');
});

test('session status and relative update labels stay compact and localized', () => {
    const now = Date.parse('2026-07-19T12:00:00.000Z');
    assert.equal(sessionStatusLabel('running'), '进行中');
    assert.equal(sessionStatusLabel('read-only'), '可继续');
    assert.equal(sessionRelativeTime('2026-07-19T11:59:40.000Z', now), '刚刚');
    assert.equal(sessionRelativeTime('2026-07-19T11:42:00.000Z', now), '18 分钟前');
    assert.equal(sessionRelativeTime('2026-07-19T09:00:00.000Z', now), '3 小时前');
    assert.equal(sessionRelativeTime('2026-07-17T12:00:00.000Z', now), '2 天前');
    assert.equal(sessionRelativeTime('not-a-time', now), '时间未知');
});

test('context summary reports only current-session facts and deduplicates tools and files', () => {
    const snapshot = {
        phase: 'ready',
        workspaceTrusted: true,
        providerId: 'grok-subscription',
        models: [
            { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 256000 },
            { id: 'other', name: 'Other' }
        ],
        selectedModel: 'grok-4.5',
        sessions: [{
            appSessionId: 'active',
            title: '当前会话',
            workspaceRoot: '/workspace',
            providerId: 'grok-subscription',
            model: 'other',
            createdAt: '2026-07-19T10:00:00.000Z',
            updatedAt: '2026-07-19T12:00:00.000Z',
            status: 'running'
        }],
        activeSessionId: 'active',
        sessionContexts: {
            active: {
                totalTokens: 128000,
                contextWindow: 256000,
                usagePercent: 50,
                modelId: 'grok-4.5',
                compactionStatus: 'idle',
                compactionCount: 1,
                lastCompaction: { tokensBefore: 220000, tokensAfter: 64000, elapsedMs: 800 }
            }
        }
    };
    const transcript = [
        { id: 'user-1', kind: 'user', text: '任务', payload: { kind: 'text-delta', sessionId: 'active', role: 'user', text: '任务' } },
        { id: 'assistant-1', kind: 'assistant', text: '处理中', payload: { kind: 'text-delta', sessionId: 'active', role: 'assistant', text: '处理中' } },
        { id: 'tool-entry-a', kind: 'tool', payload: { kind: 'tool-call', sessionId: 'active', toolCallId: 'tool-a', title: 'call-a', toolName: 'read', status: 'running' } },
        { id: 'tool-entry-a-copy', kind: 'tool', payload: { kind: 'tool-call', sessionId: 'active', toolCallId: 'tool-a', title: 'call-a', toolName: 'read', status: 'completed' } },
        { id: 'diff-1', kind: 'diff', payload: { kind: 'diff', diffId: 'diff-1', sessionId: 'active', path: 'src\\example.ts', diff: '' } },
        { id: 'diff-2', kind: 'diff', payload: { kind: 'diff', diffId: 'diff-2', sessionId: 'active', path: 'src/example.ts', diff: '' } },
        { id: 'other-user', kind: 'user', text: '旧会话', payload: { kind: 'text-delta', sessionId: 'other-session', role: 'user', text: '旧会话' } }
    ];

    assert.deepEqual(summarizeAgentContext(snapshot, transcript), {
        messageCount: 2,
        toolCount: 1,
        changedFileCount: 1,
        currentModelId: 'grok-4.5',
        currentModelName: 'Grok 4.5',
        contextWindow: 256000,
        totalTokens: 128000,
        usagePercent: 50,
        compactionStatus: 'idle',
        compactionCount: 1,
        lastCompaction: { tokensBefore: 220000, tokensAfter: 64000, elapsedMs: 800 }
    });
});
