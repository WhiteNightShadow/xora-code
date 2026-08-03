const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSessionExportMarkdown } = require('../lib/electron-main/session-export');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

test('session export groups thoughts and keeps only the latest tool projection', () => {
    const session = {
        appSessionId: 'a', acpSessionId: 'acp-a', title: '修复 Agent', workspaceRoot: '/secret/workspace',
        providerId: 'grok-subscription', model: 'grok-4.5', createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:00.000Z', status: 'completed'
    };
    const events = [
        { kind: 'text-delta', sessionId: 'a', turnId: 't1', role: 'user', text: '请修复问题' },
        { kind: 'thought-delta', sessionId: 'a', turnId: 't1', thoughtId: 'thought-1', text: '先定位，' },
        { kind: 'thought-delta', sessionId: 'a', turnId: 't1', thoughtId: 'thought-1', text: '再验证。' },
        { kind: 'thought-delta', sessionId: 'a', turnId: 't1', thoughtId: 'thought-1', text: '', completed: true, elapsedMs: 1250 },
        { kind: 'tool-call', sessionId: 'a', turnId: 't1', toolCallId: 'tool-1', title: '运行测试', toolName: 'test', status: 'running' },
        { kind: 'tool-call', sessionId: 'a', turnId: 't1', toolCallId: 'tool-1', title: '运行测试', toolName: 'test', status: 'completed', output: '通过' },
        { kind: 'text-delta', sessionId: 'a', turnId: 't1', role: 'assistant', text: '已经修复。' },
        { kind: 'turn-completed', sessionId: 'a', turnId: 't1', stopReason: 'end_turn', elapsedMs: 2400 }
    ];

    const markdown = buildSessionExportMarkdown(session, events, new Date('2026-08-03T01:00:00.000Z'));
    assert.match(markdown, /^# 修复 Agent/m);
    assert.match(markdown, /<summary>思考过程 · 1\.3 秒<\/summary>/);
    assert.match(markdown, /先定位，再验证。/);
    assert.equal((markdown.match(/### Agent 活动 · 运行测试/g) ?? []).length, 1);
    assert.match(markdown, /通过/);
    assert.match(markdown, /## Agent\n\n已经修复。/);
    assert.doesNotMatch(markdown, /\/secret\/workspace/, 'workspace root is metadata, not exported content');
});

test('session export is rejected before opening a save dialog while a task is running', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    host.sessions = { get: () => ({ appSessionId: 'a', status: 'running' }) };
    host.activePrompts = new Map([['a', {}]]);

    await assert.rejects(
        () => host.exportSession('a'),
        /当前任务仍在运行/
    );
});
