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

test('live text, tool, plan and diff updates publish once per animation frame', () => {
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
    model.accept({
        kind: 'plan',
        sessionId: 'session-a',
        entries: [{ id: 'inspect', text: 'Inspect', status: 'in-progress' }]
    });
    model.accept({
        kind: 'diff',
        sessionId: 'session-a',
        diffId: 'diff-a',
        path: 'src/index.ts',
        diff: '-before\n+after'
    });

    assert.equal(changes, 0, 'state reduction should not force an intermediate paint');
    assert.equal(frames.scheduled.size, 1, 'one frame should own the entire burst');
    assert.equal(model.transcript.find(entry => entry.kind === 'assistant').text, 'Hello world');
    frames.flushNext();
    assert.equal(changes, 1);

    model.accept({ kind: 'text-delta', sessionId: 'session-a', role: 'assistant', text: '!' });
    assert.equal(frames.scheduled.size, 1, 'the next burst should use a new frame');
    frames.flushNext();
    disposable.dispose();
    assert.equal(changes, 2);
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
