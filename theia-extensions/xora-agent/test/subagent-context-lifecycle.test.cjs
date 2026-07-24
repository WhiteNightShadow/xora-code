const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { presentAgentTool, toolMatchesActivityFilter } = require('../lib/browser/agent-display-helpers');
const { AgentViewModel } = require('../lib/browser/agent-view-model');
const { AgentSessionRepository } = require('../lib/electron-main/session-repository');

const SESSION_A = '00000000-0000-4000-8000-000000000021';
const SESSION_B = '00000000-0000-4000-8000-000000000022';

function session(appSessionId, status = 'idle') {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: appSessionId === SESSION_A ? 'A' : 'B',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
        status
    };
}

function backgroundTask(sessionId, status, turnId = 'turn-child') {
    return {
        kind: 'tool-call',
        sessionId,
        turnId,
        toolCallId: 'child-tool-1',
        title: 'background_task_action',
        toolName: 'background_task_action',
        toolKind: 'background_task_action',
        presentation: { action: 'subagent', source: 'builtin' },
        status,
        input: { subagent_type: 'explore', description: '检查运行时状态' }
    };
}

test('subagent ACP tools have concise start, wait and stop activity labels', () => {
    const started = presentAgentTool(backgroundTask(SESSION_A, 'running'));
    assert.deepEqual(started, {
        action: 'subagent',
        source: 'builtin',
        filter: 'agent',
        badgeLabel: 'Agent',
        title: '启动后台任务 · explore',
        detailLabel: '后台任务由 Agent Runtime 调度',
        iconClass: 'codicon-organization',
        tone: 'agent',
        readOnly: undefined
    });
    assert.equal(toolMatchesActivityFilter(backgroundTask(SESSION_A, 'running'), 'agent'), true);
    assert.equal(toolMatchesActivityFilter(backgroundTask(SESSION_A, 'running'), 'other'), false);

    const waiting = presentAgentTool({
        ...backgroundTask(SESSION_A, 'running'),
        toolName: 'wait_tasks_action',
        toolKind: 'wait_tasks_action',
        input: undefined
    });
    assert.equal(waiting.title, '等待后台任务');
    assert.equal(waiting.detailLabel, '正在汇总子任务结果');

    const stopped = presentAgentTool({
        ...backgroundTask(SESSION_A, 'completed'),
        toolName: 'kill_task_action',
        toolKind: 'kill_task_action',
        input: undefined
    });
    assert.equal(stopped.title, '停止后台任务');

    const legacy = presentAgentTool({
        title: 'spawn_subagent',
        toolCallId: 'legacy-child',
        toolName: 'spawn_subagent',
        input: { agent_name: 'plan' }
    });
    assert.equal(legacy.action, 'subagent');
    assert.equal(legacy.title, '运行子 Agent · plan');
});

test('background child activity is session-isolated and becomes visible from persisted history', () => {
    const model = new AgentViewModel();
    const a = session(SESSION_A);
    const b = session(SESSION_B, 'running');
    model.snapshot.sessions = [a, b];
    model.setSession(a);

    model.accept(backgroundTask(SESSION_B, 'running'));
    assert.equal(model.transcript.length, 0, 'a background tab must not leak into the visible conversation');

    model.showSessionHistory(b, [
        backgroundTask(SESSION_B, 'running'),
        { ...backgroundTask(SESSION_B, 'completed'), elapsedMs: 1250 }
    ]);
    assert.equal(model.transcript.length, 1);
    assert.equal(model.transcript[0].payload.status, 'completed');
    assert.equal(model.transcript[0].payload.elapsedMs, 1250);
    assert.match(presentAgentTool(model.transcript[0].payload).title, /启动后台任务/);
});

test('automatic-compaction state and child activity survive the redacted JSONL round trip', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-context-child-history-'));
    const repository = new AgentSessionRepository(root);
    const context = {
        kind: 'context-usage',
        sessionId: SESSION_A,
        turnId: 'turn-child',
        context: {
            totalTokens: 42000,
            contextWindow: 200000,
            usagePercent: 21,
            modelId: 'grok',
            compactionStatus: 'idle',
            compactionCount: 1,
            lastCompaction: { tokensBefore: 170000, tokensAfter: 42000, elapsedMs: 312 }
        }
    };
    try {
        repository.appendEvent(SESSION_A, backgroundTask(SESSION_A, 'completed'));
        repository.appendEvent(SESSION_A, context);
        assert.deepEqual(repository.readEvents(SESSION_A), [backgroundTask(SESSION_A, 'completed'), context]);
        repository.dispose();

        const reopened = new AgentSessionRepository(root);
        try {
            const restored = reopened.readEvents(SESSION_A);
            assert.equal(restored[0].presentation.action, 'subagent');
            assert.equal(restored[0].turnId, 'turn-child');
            assert.equal(restored[1].context.compactionCount, 1);
            assert.deepEqual(restored[1].context.lastCompaction, {
                tokensBefore: 170000,
                tokensAfter: 42000,
                elapsedMs: 312
            });
        } finally {
            reopened.dispose();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
