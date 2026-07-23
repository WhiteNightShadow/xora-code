const assert = require('node:assert/strict');
const test = require('node:test');

const { AgentViewModel } = require('../lib/browser/agent-view-model');

function permission(requestId, sessionId) {
    return {
        kind: 'permission-request',
        requestId,
        sessionId,
        title: `Permission ${requestId}`,
        options: ['allow-once', 'reject']
    };
}

function session(appSessionId, status) {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: appSessionId,
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status
    };
}

function snapshot(phase) {
    return {
        phase,
        workspaceTrusted: true,
        providerId: 'grok-subscription',
        models: [],
        sessions: []
    };
}

function imageAttachment(name = 'screenshot.png') {
    return {
        kind: 'image',
        mimeType: 'image/png',
        byteSize: 1024,
        sha256: 'a'.repeat(64),
        name
    };
}

function animationFrameHarness(model) {
    let nextId = 1;
    const scheduled = new Map();
    const callbacks = new Map();
    const cancelled = [];
    model.requestChangeFrame = callback => {
        const id = nextId++;
        scheduled.set(id, callback);
        callbacks.set(id, callback);
        return id;
    };
    model.cancelChangeFrame = id => {
        cancelled.push(id);
        scheduled.delete(id);
    };
    return {
        scheduled,
        callbacks,
        cancelled,
        flushNext() {
            const next = scheduled.entries().next().value;
            assert.ok(next, 'an animation frame should be scheduled');
            const [id, callback] = next;
            scheduled.delete(id);
            callback(0);
            return id;
        }
    };
}

test('stream noise stays frame-batched while new running activity publishes immediately', () => {
    const model = new AgentViewModel();
    const frames = animationFrameHarness(model);
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);

    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'Hello ' });
    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'world' });
    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'tool-a',
        title: 'Read file',
        toolName: 'filesystem/read_file',
        status: 'running'
    });
    assert.equal(changes, 1, 'the first running tool must become visible immediately');
    assert.equal(frames.scheduled.size, 0, 'the immediate activity edge cancels the pending text frame');
    model.accept({
        kind: 'plan',
        sessionId: 'session-a',
        entries: [{ id: 'inspect', text: 'Inspect', status: 'in-progress' }]
    });
    assert.equal(changes, 2, 'the first in-progress plan must become visible immediately');
    model.accept({
        kind: 'diff',
        sessionId: 'session-a',
        diffId: 'diff-a',
        path: 'src/index.ts',
        diff: '-before\n+after'
    });

    assert.equal(frames.scheduled.size, 1, 'non-lifecycle output still uses one frame');
    assert.equal(model.transcript.find(entry => entry.kind === 'assistant').text, 'Hello world');
    frames.flushNext();
    assert.equal(changes, 3);

    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: '!' });
    assert.equal(frames.scheduled.size, 1, 'the next burst should use a new frame');
    frames.flushNext();
    disposable.dispose();
    assert.equal(changes, 4);
});

test('running tool lifecycle paints before its terminal update and keeps one card', () => {
    const model = new AgentViewModel();
    const frames = animationFrameHarness(model);
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);

    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'tool-a',
        title: 'Read file',
        toolName: 'filesystem/read_file',
        status: 'running'
    });
    assert.equal(changes, 1);
    assert.equal(model.transcript.filter(entry => entry.kind === 'tool').length, 1);
    assert.equal(model.transcript.find(entry => entry.kind === 'tool').payload.status, 'running');

    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'tool-a',
        title: 'Read file',
        toolName: 'filesystem/read_file',
        status: 'completed',
        output: 'done'
    });
    assert.equal(changes, 1, 'terminal details may settle on the next frame');
    assert.equal(frames.scheduled.size, 1);
    frames.flushNext();
    assert.equal(changes, 2);
    assert.equal(model.transcript.filter(entry => entry.kind === 'tool').length, 1);
    assert.equal(model.transcript.find(entry => entry.kind === 'tool').payload.status, 'completed');
    disposable.dispose();
});

test('critical events cancel a pending frame and notify immediately without a stale callback', () => {
    const model = new AgentViewModel();
    const frames = animationFrameHarness(model);
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);
    const criticalEvents = [
        { kind: 'snapshot', snapshot: snapshot('ready') },
        { kind: 'session', session: session('session-a', 'running') },
        permission('permission-a', 'session-a'),
        { kind: 'turn-completed', sessionId: 'session-a', stopReason: 'end_turn' },
        { kind: 'error', sessionId: 'session-a', code: 'FIXTURE_ERROR', message: 'Fixture error', recoverable: true }
    ];

    for (const event of criticalEvents) {
        model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: '.' });
        const pendingId = [...frames.scheduled.keys()][0];
        const staleCallback = frames.callbacks.get(pendingId);
        assert.ok(staleCallback);

        const before = changes;
        model.accept(event);
        assert.equal(changes, before + 1, `${event.kind} should notify synchronously`);
        assert.ok(frames.cancelled.includes(pendingId));
        assert.equal(frames.scheduled.size, 0);

        staleCallback(0);
        assert.equal(changes, before + 1, 'a cancelled frame must not publish a duplicate change');
    }
    disposable.dispose();
});

test('browser-less live updates use a single cancellable microtask fallback', async () => {
    const model = new AgentViewModel();
    model.requestChangeFrame = () => undefined;
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);

    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'one' });
    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: ' two' });
    model.accept({
        kind: 'plan',
        sessionId: 'session-a',
        entries: [{ id: 'inspect', text: 'Inspect', status: 'pending' }]
    });
    assert.equal(changes, 0);
    await Promise.resolve();
    assert.equal(changes, 1);

    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: ' three' });
    model.accept(permission('permission-a', 'session-a'));
    assert.equal(changes, 2, 'the critical event should flush the visible state immediately');
    await Promise.resolve();
    disposable.dispose();
    assert.equal(changes, 2, 'the cancelled fallback microtask must stay silent');
});

test('plans are updated in place per session instead of producing duplicate cards', () => {
    const model = new AgentViewModel();
    model.accept({
        kind: 'plan',
        sessionId: 'session-a',
        title: 'Initial plan',
        entries: [{ id: 'inspect', text: 'Inspect', status: 'in-progress' }]
    });
    const originalId = model.transcript[0].id;

    model.accept({
        kind: 'plan',
        sessionId: 'session-a',
        entries: [{ id: 'inspect', text: 'Inspect', status: 'completed' }]
    });
    model.accept({
        kind: 'plan',
        sessionId: 'session-b',
        title: 'Other plan',
        entries: [{ id: 'verify', text: 'Verify', status: 'pending' }]
    });

    const plans = model.transcript.filter(entry => entry.kind === 'plan');
    assert.equal(plans.length, 2);
    assert.equal(plans[0].id, originalId);
    assert.equal(plans[0].payload.title, 'Initial plan');
    assert.equal(plans[0].payload.entries[0].status, 'completed');
    assert.equal(plans[1].payload.sessionId, 'session-b');
});

test('loading history applies all events with a single change notification', () => {
    const model = new AgentViewModel();
    const frames = animationFrameHarness(model);
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);

    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'stale live output' });
    const pendingId = [...frames.scheduled.keys()][0];
    const staleCallback = frames.callbacks.get(pendingId);

    model.loadHistory([
        { kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'Hello ' },
        { kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'world' },
        {
            kind: 'plan',
            sessionId: 'session-a',
            entries: [{ id: 'inspect', text: 'Inspect', status: 'pending' }]
        },
        {
            kind: 'plan',
            sessionId: 'session-a',
            entries: [{ id: 'inspect', text: 'Inspect', status: 'completed' }]
        },
        permission('historic-permission', 'session-a')
    ]);

    staleCallback(0);
    disposable.dispose();
    assert.equal(changes, 1);
    assert.ok(frames.cancelled.includes(pendingId));
    assert.equal(model.transcript.filter(entry => entry.kind === 'plan').length, 1);
    assert.equal(model.transcript.find(entry => entry.kind === 'assistant').text, 'Hello world');
    assert.equal(model.pendingPermissions.size, 0);
});

test('showing a selected session history also publishes exactly one change', () => {
    const model = new AgentViewModel();
    const frames = animationFrameHarness(model);
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);

    model.accept({ kind: 'text-delta', sessionId: 'old-session', role: 'assistant', text: 'old live output' });
    const pendingId = [...frames.scheduled.keys()][0];
    const staleCallback = frames.callbacks.get(pendingId);
    model.showSessionHistory(session('session-a', 'completed'), [
        { kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'restored history' }
    ]);

    staleCallback(0);
    disposable.dispose();
    assert.equal(changes, 1);
    assert.ok(frames.cancelled.includes(pendingId));
    assert.equal(model.snapshot.activeSessionId, 'session-a');
    assert.deepEqual(model.transcript.map(entry => entry.text), ['restored history']);
});

test('background permission requests survive session switches, new drafts and history restores', () => {
    const model = new AgentViewModel();
    const sessionA = session('session-a', 'running');
    const sessionB = session('session-b', 'idle');
    model.snapshot.sessions = [sessionA, sessionB];
    model.setSession(sessionA);
    model.accept(permission('permission-a', 'session-a'));

    model.setSession(sessionB);
    assert.deepEqual([...model.pendingPermissions.keys()], ['permission-a']);

    model.startNewSession();
    assert.deepEqual([...model.pendingPermissions.keys()], ['permission-a']);

    model.showSessionHistory(sessionB, [
        { kind: 'text-delta', sessionId: 'session-b', role: 'assistant', text: 'restored B' },
        permission('historic-permission-b', 'session-b')
    ]);
    assert.deepEqual(
        [...model.pendingPermissions.keys()],
        ['permission-a'],
        'a historical permission card must not become live, while A remains actionable in the background'
    );
});

test('attachment text events stay isolated from adjacent messages with the same role', () => {
    const model = new AgentViewModel();
    const attachment = imageAttachment();

    model.loadHistory([
        { kind: 'text-delta', sessionId: 'session-a', role: 'user', text: 'before' },
        {
            kind: 'text-delta',
            sessionId: 'session-a',
            role: 'user',
            text: 'inspect this',
            attachments: [attachment]
        },
        { kind: 'text-delta', sessionId: 'session-a', role: 'user', text: 'after' }
    ]);

    assert.equal(model.transcript.length, 3);
    assert.deepEqual(model.transcript.map(entry => entry.text), ['before', 'inspect this', 'after']);
    assert.deepEqual(model.transcript[1].payload.attachments, [attachment]);
});

test('image-only user messages and optimistic attachment summaries are retained', () => {
    const model = new AgentViewModel();
    const historicAttachment = imageAttachment('historic.png');
    const optimisticAttachment = imageAttachment('draft.png');

    model.loadHistory([{
        kind: 'text-delta',
        sessionId: 'session-a',
        role: 'user',
        text: '',
        attachments: [historicAttachment]
    }]);
    model.addUserMessage('session-a', '', [optimisticAttachment]);

    assert.equal(model.transcript.length, 2);
    assert.equal(model.transcript[0].text, '');
    assert.deepEqual(model.transcript[0].payload.attachments, [historicAttachment]);
    assert.equal(model.transcript[1].text, '');
    assert.deepEqual(model.transcript[1].payload.attachments, [optimisticAttachment]);
});

test('legacy ACP extension diagnostics stay out of the visible conversation', () => {
    const model = new AgentViewModel();
    model.loadHistory([
        {
            kind: 'text-delta',
            sessionId: 'session-a',
            role: 'system',
            text: 'Ignored compatible ACP extension: _x.ai/session_notification'
        },
        { kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: 'Useful answer' }
    ]);

    assert.deepEqual(model.transcript.map(entry => entry.text), ['Useful answer']);
});

test('authoritative context updates stay outside chat and remain session-isolated', () => {
    const model = new AgentViewModel();
    model.snapshot.sessions = [session('session-a', 'running'), session('session-b', 'idle')];
    model.setSession(session('session-a', 'running'));

    model.accept({
        kind: 'context-usage',
        sessionId: 'session-b',
        context: { totalTokens: 90000, contextWindow: 100000, usagePercent: 90, compactionStatus: 'running', compactionCount: 0 }
    });
    assert.equal(model.snapshot.sessionContexts?.['session-b'], undefined);

    model.accept({
        kind: 'context-usage',
        sessionId: 'session-a',
        context: {
            totalTokens: 32000,
            contextWindow: 200000,
            usagePercent: 16,
            modelId: 'grok',
            compactionStatus: 'idle',
            compactionCount: 2,
            lastCompaction: { tokensBefore: 170000, tokensAfter: 32000 }
        }
    });
    assert.equal(model.transcript.length, 0);
    assert.equal(model.snapshot.sessionContexts['session-a'].compactionCount, 2);
    assert.equal(model.snapshot.sessionContexts['session-a'].totalTokens, 32000);
});

test('terminal session states and runtime crashes clear only the relevant pending permissions', () => {
    const model = new AgentViewModel();
    model.accept(permission('permission-a', 'session-a'));
    model.accept(permission('permission-b', 'session-b'));

    model.accept({ kind: 'turn-completed', sessionId: 'session-a', stopReason: 'cancelled' });
    assert.deepEqual([...model.pendingPermissions.keys()], ['permission-b']);

    model.accept(permission('permission-a-2', 'session-a'));
    model.accept({ kind: 'session', session: session('session-a', 'cancelled') });
    assert.deepEqual([...model.pendingPermissions.keys()], ['permission-b']);

    model.accept({ kind: 'snapshot', snapshot: snapshot('crashed') });
    assert.equal(model.pendingPermissions.size, 0);

    model.accept(permission('permission-after-crash', 'session-a'));
    model.accept({
        kind: 'error',
        code: 'SIDECAR_CRASHED',
        message: 'Fixture sidecar crashed.',
        recoverable: true
    });
    assert.equal(model.pendingPermissions.size, 0);
});

test('tool completion updates retain readable metadata from the initial call', () => {
    const model = new AgentViewModel();
    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'call-12345678',
        title: '读取项目清单',
        toolName: 'filesystem/read_file',
        status: 'running',
        input: { path: '/workspace/package.json' }
    });
    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'call-12345678',
        title: 'call-12345678',
        toolName: 'tool',
        status: 'completed',
        output: 'done'
    });

    assert.equal(model.transcript.length, 1);
    assert.deepEqual(model.transcript[0].payload, {
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'call-12345678',
        title: '读取项目清单',
        toolName: 'filesystem/read_file',
        status: 'completed',
        input: { path: '/workspace/package.json' },
        output: 'done'
    });
});

test('tool activity duration starts immediately, freezes on completion and never revives', () => {
    const model = new AgentViewModel();
    let now = Date.parse('2026-07-23T10:00:00.000Z');
    model.now = () => now;
    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'long-file-edit',
        title: '修改文件',
        toolName: 'apply_patch',
        status: 'running',
        startedAt: new Date(now).toISOString()
    });

    now += 3_100;
    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'long-file-edit',
        title: '修改文件',
        toolName: 'apply_patch',
        status: 'completed'
    });
    now += 7_000;
    model.accept({
        kind: 'tool-call',
        sessionId: 'session-a',
        toolCallId: 'long-file-edit',
        title: 'late running update',
        toolName: 'tool',
        status: 'running'
    });

    assert.equal(model.transcript.length, 1);
    assert.equal(model.transcript[0].payload.status, 'completed');
    assert.equal(model.transcript[0].payload.elapsedMs, 3_100);
    assert.equal(model.transcript[0].payload.startedAt, '2026-07-23T10:00:00.000Z');
});

test('turn completion freezes elapsed time for a tool missing its terminal update', () => {
    const model = new AgentViewModel();
    let now = Date.parse('2026-07-23T10:00:00.000Z');
    model.now = () => now;
    model.snapshot.sessions = [session('session-a', 'running')];
    model.setSession(session('session-a', 'running'));
    model.accept({
        kind: 'tool-call', sessionId: 'session-a', toolCallId: 'pending', title: 'Search', toolName: 'search',
        status: 'running', startedAt: new Date(now).toISOString()
    });
    now += 2_600;

    model.accept({ kind: 'turn-completed', sessionId: 'session-a', stopReason: 'end_turn', elapsedMs: 2_600 });

    const tool = model.transcript.find(entry => entry.kind === 'tool').payload;
    assert.equal(tool.status, 'completed');
    assert.equal(tool.elapsedMs, 2_600);
});

test('terminal turns keep tool status monotonic, finish lingering activity and attach AI elapsed time', () => {
    const model = new AgentViewModel();
    model.snapshot.sessions = [session('session-a', 'running')];
    model.setSession(session('session-a', 'running'));
    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: '完成结果' });
    model.accept({
        kind: 'tool-call', sessionId: 'session-a', toolCallId: 'done', title: 'Read', toolName: 'read', status: 'completed'
    });
    model.accept({
        kind: 'tool-call', sessionId: 'session-a', toolCallId: 'done', title: 'Read output', toolName: 'read', status: 'running', output: 'late'
    });
    model.accept({
        kind: 'tool-call', sessionId: 'session-a', toolCallId: 'lingering', title: 'Search', toolName: 'search', status: 'running'
    });
    model.accept({
        kind: 'plan', sessionId: 'session-a', entries: [{ id: 'finish', text: 'Finish', status: 'in-progress' }]
    });

    model.accept({ kind: 'turn-completed', sessionId: 'session-a', stopReason: 'end_turn', elapsedMs: 1_234 });

    const tools = model.transcript.filter(entry => entry.kind === 'tool').map(entry => entry.payload);
    assert.deepEqual(tools.map(tool => tool.status), ['completed', 'completed']);
    assert.equal(model.transcript.find(entry => entry.kind === 'plan').payload.entries[0].status, 'completed');
    const reply = model.transcript.find(entry => entry.kind === 'assistant');
    assert.equal(reply.turnElapsedMs, 1_234);
    assert.equal(reply.turnStopReason, 'end_turn');
});

test('cancelled sessions settle unfinished tools instead of leaving activity running', () => {
    const model = new AgentViewModel();
    model.snapshot.sessions = [session('session-a', 'running')];
    model.setSession(session('session-a', 'running'));
    model.accept({
        kind: 'tool-call', sessionId: 'session-a', toolCallId: 'pending', title: 'Execute', toolName: 'execute', status: 'pending'
    });

    model.accept({ kind: 'session', session: session('session-a', 'cancelled') });

    assert.equal(model.transcript.find(entry => entry.kind === 'tool').payload.status, 'rejected');
});

test('identical running and completed file diffs are merged by semantic content', () => {
    const model = new AgentViewModel();
    const running = {
        kind: 'diff',
        sessionId: 'session-a',
        toolCallId: 'edit-1',
        diffId: 'diff-running',
        path: 'docs\\drafts\\..\\project-overview.md',
        oldPath: '/history/before-running',
        oldHash: 'old-hash',
        newHash: 'new-hash',
        diff: '-before\n+after'
    };
    const completed = {
        ...running,
        diffId: 'diff-completed',
        path: 'docs/project-overview.md',
        oldPath: '/history/before-completed'
    };

    model.loadHistory([running, completed]);

    const diffs = model.transcript.filter(entry => entry.kind === 'diff');
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].payload.diffId, 'diff-completed');
    assert.equal(diffs[0].payload.oldPath, '/history/before-completed');
});

test('persisted turn ids keep interleaved tools in one activity and isolate reused tool and diff identities', () => {
    const model = new AgentViewModel();
    const sharedDiff = {
        kind: 'diff',
        sessionId: 'session-a',
        toolCallId: 'edit-shared',
        path: 'src/shared.ts',
        oldHash: 'old-shared',
        newHash: 'new-shared',
        diff: '-before\n+after'
    };

    model.loadHistory([
        { kind: 'text-delta', sessionId: 'session-a', turnId: 'turn-1', role: 'user', text: 'first turn' },
        {
            kind: 'tool-call', sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'edit-shared',
            title: 'Edit shared', toolName: 'apply_patch', status: 'completed'
        },
        { ...sharedDiff, turnId: 'turn-1', diffId: 'diff-shared-turn-1' },
        {
            kind: 'tool-call', sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'edit-second',
            title: 'Edit second', toolName: 'apply_patch', status: 'completed'
        },
        {
            kind: 'diff', sessionId: 'session-a', turnId: 'turn-1', toolCallId: 'edit-second',
            diffId: 'diff-second', path: 'src/second.ts', oldHash: 'old-second', newHash: 'new-second',
            diff: '-old second\n+new second'
        },
        { kind: 'turn-completed', sessionId: 'session-a', turnId: 'turn-1', stopReason: 'end_turn' },
        { kind: 'text-delta', sessionId: 'session-a', turnId: 'turn-2', role: 'user', text: 'second turn' },
        {
            kind: 'tool-call', sessionId: 'session-a', turnId: 'turn-2', toolCallId: 'edit-shared',
            title: 'Edit shared again', toolName: 'apply_patch', status: 'completed'
        },
        { ...sharedDiff, turnId: 'turn-2', diffId: 'diff-shared-turn-2' },
        { kind: 'turn-completed', sessionId: 'session-a', turnId: 'turn-2', stopReason: 'end_turn' }
    ]);

    const tools = model.transcript.filter(entry => entry.kind === 'tool');
    const diffs = model.transcript.filter(entry => entry.kind === 'diff');
    assert.equal(tools.length, 3, 'a reused toolCallId must remain visible in its later turn');
    assert.equal(diffs.length, 3, 'the same semantic diff must remain visible when it belongs to a later turn');
    assert.equal(tools[0].activityTurnId, 'activity:session-a:turn-1');
    assert.equal(tools[1].activityTurnId, tools[0].activityTurnId,
        'tool -> diff -> tool -> diff in one turn must share one activity group');
    assert.equal(diffs[0].activityTurnId, tools[0].activityTurnId);
    assert.equal(diffs[1].activityTurnId, tools[0].activityTurnId);
    assert.equal(tools[2].activityTurnId, 'activity:session-a:turn-2');
    assert.equal(diffs[2].activityTurnId, tools[2].activityTurnId);
    assert.notEqual(tools[2].activityTurnId, tools[0].activityTurnId);
});

test('legacy history infers activity turns from user messages and turn completion boundaries', () => {
    const model = new AgentViewModel();
    const legacyDiff = {
        kind: 'diff',
        sessionId: 'session-a',
        toolCallId: 'legacy-edit',
        path: 'src/legacy.ts',
        oldHash: 'legacy-old',
        newHash: 'legacy-new',
        diff: '-legacy before\n+legacy after'
    };

    model.loadHistory([
        { kind: 'text-delta', sessionId: 'session-a', role: 'user', text: 'legacy first turn' },
        {
            kind: 'tool-call', sessionId: 'session-a', toolCallId: 'legacy-edit',
            title: 'Legacy edit', toolName: 'apply_patch', status: 'completed'
        },
        { ...legacyDiff, diffId: 'legacy-diff-1' },
        {
            kind: 'tool-call', sessionId: 'session-a', toolCallId: 'legacy-follow-up',
            title: 'Legacy follow-up', toolName: 'apply_patch', status: 'completed'
        },
        { kind: 'turn-completed', sessionId: 'session-a', stopReason: 'end_turn' },
        { kind: 'text-delta', sessionId: 'session-a', role: 'user', text: 'legacy second turn' },
        {
            kind: 'tool-call', sessionId: 'session-a', toolCallId: 'legacy-edit',
            title: 'Legacy edit again', toolName: 'apply_patch', status: 'completed'
        },
        { ...legacyDiff, diffId: 'legacy-diff-2' },
        { kind: 'turn-completed', sessionId: 'session-a', stopReason: 'end_turn' }
    ]);

    const tools = model.transcript.filter(entry => entry.kind === 'tool');
    const diffs = model.transcript.filter(entry => entry.kind === 'diff');
    assert.equal(tools.length, 3);
    assert.equal(diffs.length, 2, 'legacy turns must not deduplicate the same edit across turn boundaries');
    assert.equal(tools[0].activityTurnId, 'activity:session-a:legacy-1');
    assert.equal(tools[1].activityTurnId, tools[0].activityTurnId);
    assert.equal(diffs[0].activityTurnId, tools[0].activityTurnId);
    assert.equal(tools[2].activityTurnId, 'activity:session-a:legacy-2');
    assert.equal(diffs[1].activityTurnId, tools[2].activityTurnId);
});

test('incomplete diff identities remain separate and transcript resets clear dedupe state', () => {
    const base = {
        kind: 'diff',
        sessionId: 'session-a',
        toolCallId: 'edit-1',
        path: 'docs/project-overview.md',
        oldHash: 'old-hash',
        newHash: 'new-hash',
        diff: '-before\n+after'
    };
    const model = new AgentViewModel();

    model.loadHistory([
        { ...base, toolCallId: undefined, diffId: 'legacy-a' },
        { ...base, toolCallId: undefined, diffId: 'legacy-b' },
        { ...base, oldHash: undefined, diffId: 'legacy-c' },
        { ...base, oldHash: undefined, diffId: 'legacy-d' },
        { ...base, newHash: undefined, diffId: 'legacy-e' },
        { ...base, newHash: undefined, diffId: 'legacy-f' },
        { ...base, path: '', diffId: 'legacy-g' },
        { ...base, path: '', diffId: 'legacy-h' },
        { ...base, sessionId: '', diffId: 'legacy-i' },
        { ...base, sessionId: '', diffId: 'legacy-j' }
    ]);
    assert.equal(model.transcript.filter(entry => entry.kind === 'diff').length, 10);

    model.loadHistory([{ ...base, diffId: 'after-clear' }]);
    assert.equal(model.transcript.length, 1);
    assert.equal(model.transcript[0].payload.diffId, 'after-clear');
});
