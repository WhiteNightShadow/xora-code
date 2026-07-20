const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

function session(appSessionId, status = 'idle') {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: `Session ${appSessionId}`,
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        status
    };
}

function hostHarness() {
    const host = Object.create(GrokAgentHostService.prototype);
    const ipc = [];
    const history = [];
    const lifecycle = [];
    host.pendingAssistantTextDeltas = new Map();
    host.assistantStreamsStarted = new Set();
    host.currentSecrets = [];
    host.knownSessionIds = new Set(['a', 'b']);
    host.client = { onAgentEvent: event => ipc.push(event) };
    host.sessions = {
        appendEvent: (sessionId, event) => history.push({ sessionId, event }),
        update: (sessionId, patch) => ({ ...session(sessionId), ...patch }),
        flushEvents: () => lifecycle.push('history-flush'),
        dispose: () => lifecycle.push('history-dispose')
    };
    return { host, ipc, history, lifecycle };
}

test('the first assistant chunk is immediate and later chunks use one fixed-window batch', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    assert.match(source, /ASSISTANT_TEXT_BATCH_INTERVAL_MS = 28/);

    const { host, ipc, history } = hostHarness();
    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: '你' });
    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: '好' });
    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: '！' });

    const first = { kind: 'text-delta', sessionId: 'a', role: 'assistant', text: '你' };
    assert.deepEqual(ipc, [first], 'the latency-critical first chunk must cross renderer IPC immediately');
    assert.deepEqual(history, [{ sessionId: 'a', event: first }], 'the first chunk must be durable immediately');

    await new Promise(resolve => setTimeout(resolve, 60));

    const combined = { kind: 'text-delta', sessionId: 'a', role: 'assistant', text: '好！' };
    assert.deepEqual(ipc, [first, combined]);
    assert.deepEqual(history, [{ sessionId: 'a', event: first }, { sessionId: 'a', event: combined }]);
});

test('semantic events flush the matching assistant batch before crossing either boundary', async () => {
    const { host, ipc, history } = hostHarness();
    const boundaries = [
        {
            text: 'plan-text',
            event: { kind: 'plan', sessionId: 'a', entries: [{ id: '1', text: 'Plan', status: 'pending' }] }
        },
        {
            text: 'tool-text',
            event: {
                kind: 'tool-call', sessionId: 'a', toolCallId: 'tool-1', title: 'Tool',
                toolName: 'fixture', status: 'running'
            }
        },
        {
            text: 'session-text',
            event: { kind: 'session', session: session('a', 'completed') }
        },
        {
            text: 'turn-text',
            event: { kind: 'turn-completed', sessionId: 'a', stopReason: 'end_turn' }
        },
        {
            text: 'error-text',
            event: { kind: 'error', sessionId: 'a', code: 'FIXTURE', message: 'fixture', recoverable: true }
        }
    ];

    for (const boundary of boundaries) {
        host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: boundary.text });
        host.emit(boundary.event);
    }

    assert.deepEqual(ipc.map(event => event.kind), [
        'text-delta', 'plan',
        'text-delta', 'tool-call',
        'text-delta', 'session',
        'text-delta', 'turn-completed',
        'text-delta', 'error'
    ]);
    assert.deepEqual(
        ipc.filter(event => event.kind === 'text-delta').map(event => event.text),
        boundaries.map(boundary => boundary.text)
    );
    assert.deepEqual(
        history.filter(item => item.event.kind === 'text-delta').map(item => item.event.text),
        boundaries.map(boundary => boundary.text)
    );
    assert.equal(host.pendingAssistantTextDeltas.size, 0);

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(ipc.length, boundaries.length * 2, 'cleared batch timers must not emit duplicates');
});

test('a sessionless error flushes every pending session in original batch order', () => {
    const { host, ipc } = hostHarness();
    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'A' });
    host.emit({ kind: 'text-delta', sessionId: 'b', role: 'assistant', text: 'B' });
    // Electron RPC may preserve an optional field as an own property whose
    // value is undefined. This still represents a global, not session-local,
    // error and therefore must drain every session.
    host.emit({ kind: 'error', sessionId: undefined, code: 'GLOBAL', message: 'global failure', recoverable: true });

    assert.deepEqual(ipc.map(event => event.kind), ['text-delta', 'text-delta', 'error']);
    assert.deepEqual(ipc.slice(0, 2).map(event => `${event.sessionId}:${event.text}`), ['a:A', 'b:B']);
    assert.equal(host.pendingAssistantTextDeltas.size, 0);
});

test('a sidecar crash flushes assistant text before its error and crash snapshot', () => {
    const { host, ipc, lifecycle } = hostHarness();
    host.runtimeGeneration = 7;
    host.sessionLoadGeneration = 0;
    host.phase = 'ready';
    host.intentionalStop = false;
    host.loadedSessionIds = new Set(['a']);
    host.acp = undefined;
    host.activePrompts = new Map();
    host.pendingPermissions = new Map();
    host.supervisor = { stop: () => { lifecycle.push('sidecar-stop'); return Promise.resolve(); } };
    host.emitSnapshot = message => host.emit({
        kind: 'snapshot',
        snapshot: { phase: host.phase, models: [], sessions: [], permissionMode: 'request-approval', message }
    }, false);

    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'final fragment' });
    host.runtimeFailed(new Error('fixture crash'), 7);

    assert.deepEqual(ipc.map(event => event.kind), ['text-delta', 'error', 'snapshot']);
    assert.equal(ipc[0].text, 'final fragment');
    assert.equal(ipc[1].code, 'SIDECAR_CRASHED');
    assert.equal(host.pendingAssistantTextDeltas.size, 0);
    assert.ok(lifecycle.indexOf('history-flush') >= 0);
});

test('synchronous application close flushes the final batch while the renderer is still connected', () => {
    const { host, ipc, lifecycle } = hostHarness();
    host.runtimeGeneration = 0;
    host.sessionLoadGeneration = 0;
    host.loadedSessionIds = new Set(['a']);
    host.intentionalStop = false;
    host.acp = undefined;
    host.managementChild = undefined;
    host.supervisor = { stopSync: () => lifecycle.push('sidecar-stop') };

    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'goodbye' });
    host.disposeSync();

    assert.deepEqual(ipc.map(event => event.kind), ['text-delta']);
    assert.equal(ipc[0].text, 'goodbye');
    assert.deepEqual(lifecycle, ['sidecar-stop', 'history-dispose']);
    assert.equal(host.pendingAssistantTextDeltas.size, 0);
});
