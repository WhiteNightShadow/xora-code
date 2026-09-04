const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { SidecarTerminationUnconfirmedError } = require('../lib/electron-main/sidecar-supervisor');
const { AcpWriteError } = require('@xora-code/acp-client');
const {
    AgentSessionRepository,
    SessionIndexLockError
} = require('../lib/electron-main/session-repository');

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

test('sendPrompt persists one stable turnId across every turn event and rotates it for the next prompt', async () => {
    const { host, ipc, history } = hostHarness();
    let record = {
        ...session('a'),
        providerRuntimeEpoch: 'legacy-v1'
    };
    let turnNumber = 0;
    host.phase = 'ready';
    host.workspaceRoot = '/fixture';
    host.providerId = 'grok-subscription';
    host.runtimeProviderEpoch = 'legacy-v1';
    host.selectedModel = undefined;
    host.models = [];
    host.capabilities = { prompt: { image: false } };
    host.loadedSessionIds = new Set(['a']);
    host.activePrompts = new Map();
    host.activeTurnIds = new Map();
    host.sessions.get = sessionId => sessionId === 'a' ? record : undefined;
    host.sessions.update = (_sessionId, patch) => (record = { ...record, ...patch });
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'legacy-v1',
        preferredModelId: () => undefined,
        get: providerId => ({ id: providerId, name: 'Grok Subscription', kind: 'grok-subscription' })
    };
    host.acp = {
        startRequest: () => {
            turnNumber += 1;
            const toolCallId = `tool-${turnNumber}`;
            host.emit({
                kind: 'tool-call',
                sessionId: 'a',
                toolCallId,
                title: `Tool ${turnNumber}`,
                toolName: 'fixture',
                status: 'completed'
            });
            host.emit({
                kind: 'diff',
                diffId: `diff-${turnNumber}`,
                sessionId: 'a',
                toolCallId,
                path: `fixture-${turnNumber}.ts`,
                oldHash: 'old',
                newHash: 'new',
                diff: '@@ -1 +1 @@\n-old\n+new'
            });
            host.emit({
                kind: 'text-delta',
                sessionId: 'a',
                role: 'assistant',
                text: `answer-${turnNumber}`
            });
            return {
                promise: Promise.resolve({ stopReason: 'end_turn' }),
                cancel: async () => undefined
            };
        }
    };

    await host.sendPrompt({ sessionId: 'a', text: 'first prompt' });
    assert.equal(host.activeTurnIds.size, 0, 'a completed prompt must release its active turn id');
    await host.sendPrompt({ sessionId: 'a', text: 'second prompt' });
    assert.equal(host.activeTurnIds.size, 0, 'the next completed prompt must also release its active turn id');

    const isTurnEvent = event => event.kind === 'tool-call'
        || event.kind === 'diff'
        || event.kind === 'turn-completed'
        || event.kind === 'text-delta';
    const emittedTurns = ipc.filter(isTurnEvent);
    const persistedTurns = history.map(item => item.event).filter(isTurnEvent);
    const expectedShape = [
        'text-delta:user',
        'tool-call',
        'diff',
        'text-delta:assistant',
        'turn-completed'
    ];
    const shape = event => event.kind === 'text-delta' ? `${event.kind}:${event.role}` : event.kind;

    assert.deepEqual(emittedTurns.map(shape), [...expectedShape, ...expectedShape]);
    assert.deepEqual(persistedTurns.map(shape), [...expectedShape, ...expectedShape]);
    for (const events of [emittedTurns, persistedTurns]) {
        const firstTurnId = events[0].turnId;
        const secondTurnId = events[expectedShape.length].turnId;
        assert.equal(typeof firstTurnId, 'string');
        assert.ok(firstTurnId.length > 0);
        assert.equal(typeof secondTurnId, 'string');
        assert.ok(secondTurnId.length > 0);
        assert.ok(events.slice(0, expectedShape.length).every(event => event.turnId === firstTurnId),
            JSON.stringify(events.map(event => [shape(event), event.turnId])));
        assert.ok(events.slice(expectedShape.length).every(event => event.turnId === secondTurnId),
            JSON.stringify(events.map(event => [shape(event), event.turnId])));
        assert.notEqual(secondTurnId, firstTurnId, 'each prompt must receive a fresh turn id');
    }
});

function configurePromptHarness(host, recordRef, startRequest) {
    host.phase = 'ready';
    host.workspaceRoot = '/fixture';
    host.providerId = 'grok-subscription';
    host.runtimeProviderEpoch = 'legacy-v1';
    host.selectedModel = undefined;
    host.models = [];
    host.capabilities = { prompt: { image: false } };
    host.loadedSessionIds = new Set(['a']);
    host.activePrompts = new Map();
    host.activeTurnIds = new Map();
    host.sessions.get = sessionId => sessionId === 'a' ? recordRef.current : undefined;
    host.sessions.update = (_sessionId, patch) => (recordRef.current = { ...recordRef.current, ...patch });
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'legacy-v1',
        preferredModelId: () => undefined,
        get: providerId => ({ id: providerId, name: 'Grok Subscription', kind: 'grok-subscription' })
    };
    host.acp = { startRequest };
}

test('the durable user turn is flushed before ACP admission and a flush failure sends zero ACP', async t => {
    const durable = hostHarness();
    const durableRecord = { current: { ...session('a'), providerRuntimeEpoch: 'legacy-v1' } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-prompt-admission-jsonl-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const jsonl = path.join(root, 'a.jsonl');
    let pendingHistory = [];
    durable.host.sessions.appendEvent = (sessionId, event) => {
        durable.history.push({ sessionId, event });
        pendingHistory.push(event);
    };
    durable.host.sessions.flushEvents = () => {
        if (!pendingHistory.length) return;
        fs.appendFileSync(jsonl, pendingHistory.map(event => JSON.stringify({ event })).join('\n') + '\n');
        pendingHistory = [];
    };
    configurePromptHarness(durable.host, durableRecord, () => {
        const durableHistory = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
        const user = durableHistory.find(event => event.kind === 'text-delta' && event.role === 'user');
        assert.ok(user, 'session/prompt must observe the fsynced user JSONL event');
        assert.equal(typeof user.turnId, 'string');
        return { promise: Promise.resolve({ stopReason: 'end_turn' }), cancel: async () => undefined };
    });
    const receipt = await durable.host.sendPrompt({ sessionId: 'a', text: 'durable first' });
    const stored = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
    assert.equal(stored.some(event => event.turnId === receipt.turnId && event.role === 'user'), true);

    const failed = hostHarness();
    const failedRecord = { current: { ...session('a'), providerRuntimeEpoch: 'legacy-v1' } };
    let starts = 0;
    failed.host.sessions.flushEvents = () => {
        throw Object.assign(new Error('disk full before admission'), { code: 'ENOSPC' });
    };
    configurePromptHarness(failed.host, failedRecord, () => {
        starts += 1;
        return { promise: Promise.resolve({ stopReason: 'end_turn' }), cancel: async () => undefined };
    });
    await assert.rejects(
        failed.host.sendPrompt({ sessionId: 'a', text: 'must not cross ACP' }),
        /disk full before admission/
    );
    assert.equal(starts, 0);
    assert.equal(failedRecord.current.status, 'failed', 'the pre-admission durable claim must be released');
});

test('post-admission history failures preserve completed, cancelled and failed PromptReceipts', async t => {
    for (const scenario of [
        { name: 'completed', result: () => Promise.resolve({ stopReason: 'end_turn' }), status: 'completed' },
        { name: 'cancelled', result: () => Promise.resolve({ stopReason: 'cancelled' }), status: 'cancelled' },
        { name: 'failed', result: () => Promise.reject(new Error('model failed')), status: 'failed' }
    ]) {
        await t.test(scenario.name, async () => {
            const harness = hostHarness();
            const recordRef = { current: { ...session('a'), providerRuntimeEpoch: 'legacy-v1' } };
            let flushes = 0;
            harness.host.sessions.flushEvents = () => {
                flushes += 1;
                if (flushes > 1) throw Object.assign(new Error('post-admission ENOSPC'), { code: 'ENOSPC' });
            };
            configurePromptHarness(harness.host, recordRef, () => ({
                promise: scenario.result(),
                cancel: async () => undefined
            }));

            const receipt = await harness.host.sendPrompt({ sessionId: 'a', text: scenario.name });
            assert.equal(receipt.admitted, true);
            assert.equal(receipt.outcome, scenario.status);
            assert.equal(recordRef.current.status, scenario.status,
                'history failure must never rewrite the model outcome');
            assert.equal(harness.ipc.filter(event => event.kind === 'error'
                && event.code === 'SESSION_STATE_PERSIST_FAILED').length, 1);
            if (scenario.status === 'completed') {
                assert.equal(harness.ipc.some(event => event.kind === 'error' && event.code === 'PROMPT_FAILED'), false);
            }
        });
    }
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
    host.acpConsumeEnded(7, new Error('fixture EOF'));
    host.runtimeFailed(new Error('late child exit'), 7);

    assert.deepEqual(ipc.map(event => event.kind), ['text-delta', 'error', 'snapshot']);
    assert.equal(ipc[0].text, 'final fragment');
    assert.equal(ipc[1].code, 'SIDECAR_CRASHED');
    assert.equal(host.pendingAssistantTextDeltas.size, 0);
    assert.ok(lifecycle.indexOf('history-flush') >= 0);
});

test('ACP stdout EOF enters runtime failure even when no child exit event arrives', () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const failures = [];
    host.intentionalStop = false;
    host.runtimeFailed = (error, generation) => failures.push({ error, generation });

    host.acpConsumeEnded(11);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].generation, 11);
    assert.equal(failures[0].error.name, 'AcpConnectionClosedError');
    assert.match(failures[0].error.message, /stdout reached end of stream/);

    host.intentionalStop = true;
    host.acpConsumeEnded(12);
    assert.equal(failures.length, 1, 'intentional shutdown EOF must stay silent');
});

test('layered runtime errors share one persisted non-secret group id', () => {
    const { host, ipc } = hostHarness();
    host.phase = 'crashed';
    host.runtimeErrorGroupId = undefined;

    host.emitError('PROMPT_FAILED', new Error('ACP stdout reached end of stream'), true, 'a');
    host.emitError('SIDECAR_CRASHED', new Error('Grok sidecar exited (1).'), true);

    const errors = ipc.filter(event => event.kind === 'error');
    assert.equal(errors.length, 2);
    assert.equal(typeof errors[0].errorGroupId, 'string');
    assert.ok(errors[0].errorGroupId.length > 0);
    assert.equal(errors[1].errorGroupId, errors[0].errorGroupId);
    assert.equal(JSON.stringify(errors).includes('stdout reached end of stream'), true);
});

test('real host session errors inherit the active prompt turn id', () => {
    const { host, ipc } = hostHarness();
    host.activeTurnIds = new Map([['a', 'turn-error-a']]);

    host.emitError(
        'PERMISSION_BOUNDARY_REJECTED',
        new Error('The Agent requested access outside the trusted workspace.'),
        true,
        'a'
    );

    const error = ipc.find(event => event.kind === 'error');
    assert.equal(error.turnId, 'turn-error-a');
    assert.equal(error.errorGroupId, undefined, 'ordinary turn errors must not join a runtime failure group');
});

test('runtime crash retries a terminal claim after Windows-style index lock exhaustion without replay', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-terminal-retry-'));
    const repository = new AgentSessionRepository(root);
    t.after(() => {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const created = repository.create({
        acpSessionId: 'acp-terminal-retry',
        title: 'terminal retry',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });
    const claim = repository.claimPrompt(created.appSessionId);
    const { host, ipc } = hostHarness();
    let cancels = 0;
    host.sessions = repository;
    host.knownSessionIds = new Set([created.appSessionId]);
    host.runtimeGeneration = 19;
    host.sessionLoadGeneration = 0;
    host.phase = 'ready';
    host.intentionalStop = false;
    host.disposed = false;
    host.loadedSessionIds = new Set([created.appSessionId]);
    host.activePrompts = new Map([[created.appSessionId, {
        cancel: async () => { cancels += 1; }
    }]]);
    host.promptClaimTokens = new Map([[created.appSessionId, claim.token]]);
    host.pendingPromptTerminals = new Map();
    host.pendingPermissions = new Map();
    host.acp = undefined;
    host.supervisor = { stop: async () => undefined };
    host.emitSnapshot = message => host.emit({
        kind: 'snapshot',
        snapshot: { phase: host.phase, models: [], sessions: [], permissionMode: 'request-approval', message }
    }, false);

    const lockPath = path.join(root, '.index.lock');
    fs.writeFileSync(lockPath, 'other-window\n', { mode: 0o600 });
    host.runtimeFailed(new Error('fixture sidecar crash'), 19);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(repository.get(created.appSessionId)?.status, 'running');
    assert.equal(host.activePrompts.size, 0);
    assert.equal(host.pendingPromptTerminals.has(created.appSessionId), true,
        'the failed CAS must remain terminal-pending instead of losing ownership');
    assert.equal(cancels, 1);

    const pending = host.pendingPromptTerminals.get(created.appSessionId);
    clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.attempts = 6;
    assert.equal(host.promptTerminalRetryDelay(pending.attempts), 31_000,
        'the final bounded retry must cross the repository 30s stale-lock threshold');
    host.schedulePromptTerminalRetry(created.appSessionId, pending);
    assert.equal(pending.timer.hasRef(), false, 'the long recovery timer must never keep Electron alive');
    clearTimeout(pending.timer);
    pending.timer = undefined;

    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, stale, stale);
    pending.attempts = 7;
    host.retryPendingPromptTerminal(created.appSessionId, pending);

    assert.equal(repository.get(created.appSessionId)?.status, 'failed');
    assert.equal(repository.promptClaimOwnership(created.appSessionId), 'none');
    assert.equal(host.pendingPromptTerminals.has(created.appSessionId), false);
    assert.equal(repository.readEvents(created.appSessionId).some(event => event.role === 'user'), false,
        'terminal recovery must never replay or synthesize the prompt');
    assert.equal(ipc.filter(event => event.kind === 'error' && event.code === 'SIDECAR_CRASHED').length, 1);
});

test('terminal persistence retries only index locks and reports one observable final failure', () => {
    const { host, ipc } = hostHarness();
    const appSessionId = 'a';
    host.runtimeGeneration = 23;
    host.disposed = false;
    host.promptClaimTokens = new Map([[appSessionId, 'claim-a']]);
    host.pendingPromptTerminals = new Map();
    host.sessionStatePersistenceDiagnostics = new Set();
    host.sessions.get = () => session(appSessionId, 'running');
    host.sessions.finishPrompt = () => { throw new SessionIndexLockError(); };
    host.promptClaimOwnership = () => 'owned';

    host.finishPromptRecordOrDefer(appSessionId, 'claim-a', 'failed');
    const pending = host.pendingPromptTerminals.get(appSessionId);
    clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.attempts = 7;
    host.retryPendingPromptTerminal(appSessionId, pending);
    host.retryPendingPromptTerminal(appSessionId, pending);

    assert.equal(host.pendingPromptTerminals.get(appSessionId), pending,
        'final failure must retain the owner claim for explicit recovery');
    assert.equal(host.promptClaimTokens.get(appSessionId), 'claim-a');
    assert.equal(pending.timer, undefined, 'the exhausted retry must not create a hot loop');
    assert.equal(ipc.filter(event => event.kind === 'error'
        && event.code === 'SESSION_STATE_PERSIST_FAILED').length, 1);

    const permanent = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    host.runtimeGeneration = 24;
    host.sessionStatePersistenceDiagnostics.clear();
    host.pendingPromptTerminals.clear();
    host.sessions.finishPrompt = () => { throw permanent; };
    host.finishPromptRecordOrDefer(appSessionId, 'claim-a', 'failed');
    const permanentPending = host.pendingPromptTerminals.get(appSessionId);
    assert.equal(permanentPending.retryable, false);
    assert.equal(permanentPending.timer, undefined,
        'EACCES/corruption must not be retried as if it were lock contention');
    assert.equal(ipc.filter(event => event.kind === 'error'
        && event.code === 'SESSION_STATE_PERSIST_FAILED').length, 2);
});

test('runtime failure settles the durable claim even when history flushing throws', async () => {
    const { host, ipc } = hostHarness();
    let record = session('a', 'running');
    let finishes = 0;
    host.runtimeGeneration = 29;
    host.sessionLoadGeneration = 0;
    host.phase = 'ready';
    host.intentionalStop = false;
    host.disposed = false;
    host.loadedSessionIds = new Set(['a']);
    host.activePrompts = new Map([['a', { cancel: async () => undefined }]]);
    host.promptClaimTokens = new Map([['a', 'claim-a']]);
    host.pendingPromptTerminals = new Map();
    host.pendingPermissions = new Map();
    host.sessionStatePersistenceDiagnostics = new Set();
    host.acp = undefined;
    host.supervisor = { stop: async () => undefined };
    host.sessions = {
        get: () => record,
        finishPrompt: (_id, token, status) => {
            assert.equal(token, 'claim-a');
            finishes += 1;
            record = { ...record, status };
            return record;
        },
        update: (_id, patch) => (record = { ...record, ...patch }),
        flushEvents: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
        appendEvent: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    };
    host.emitSnapshot = message => host.emit({
        kind: 'snapshot',
        snapshot: { phase: host.phase, models: [], sessions: [], permissionMode: 'request-approval', message }
    }, false);

    assert.doesNotThrow(() => host.runtimeFailed(new Error('fixture crash'), 29));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finishes, 1);
    assert.equal(record.status, 'failed');
    assert.equal(host.promptClaimTokens.has('a'), false);
    assert.equal(ipc.filter(event => event.kind === 'error'
        && event.code === 'SESSION_STATE_PERSIST_FAILED').length, 1);
});

test('crashed sessions stay termination-fenced until process-tree exit is confirmed', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-termination-fence-'));
    const repository = new AgentSessionRepository(root);
    t.after(() => {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const created = repository.create({
        acpSessionId: 'acp-fenced',
        title: 'fenced',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });
    const claim = repository.claimPrompt(created.appSessionId);
    let running = true;
    let confirmExit;
    const stopped = new Promise(resolve => { confirmExit = resolve; });
    const { host } = hostHarness();
    host.sessions = repository;
    host.knownSessionIds = new Set([created.appSessionId]);
    host.runtimeGeneration = 31;
    host.sessionLoadGeneration = 0;
    host.phase = 'ready';
    host.intentionalStop = false;
    host.disposed = false;
    host.loadedSessionIds = new Set([created.appSessionId]);
    host.activePrompts = new Map([[created.appSessionId, { cancel: async () => undefined }]]);
    host.promptClaimTokens = new Map([[created.appSessionId, claim.token]]);
    host.pendingPromptTerminals = new Map();
    host.pendingPermissions = new Map();
    host.acp = undefined;
    host.supervisor = {
        get running() { return running; },
        stop: () => stopped
    };
    host.emitSnapshot = () => undefined;

    host.runtimeFailed(new Error('fixture crash'), 31);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(repository.get(created.appSessionId)?.status, 'running');
    assert.equal(host.sidecarTerminationFences.has(created.appSessionId), true);
    await assert.rejects(host.deleteSession(created.appSessionId), /still confirming/);
    await assert.rejects(host.cancel(created.appSessionId), /still confirming/);
    assert.throws(
        () => host.claimPromptRecord(created.appSessionId, () => undefined),
        /still confirming/
    );

    running = false;
    confirmExit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.sidecarTerminationFences.has(created.appSessionId), false);
    assert.equal(repository.get(created.appSessionId)?.status, 'failed');
    assert.equal(repository.promptClaimOwnership(created.appSessionId), 'none');
    assert.equal(repository.readEvents(created.appSessionId).some(event => event.role === 'user'), false,
        'termination confirmation must settle ownership without replaying the prompt');
});

test('unconfirmed forced termination retains the running claim until a late real exit', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-termination-unconfirmed-'));
    const repository = new AgentSessionRepository(root);
    t.after(() => {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const created = repository.create({
        acpSessionId: 'acp-unconfirmed', title: 'unconfirmed', workspaceRoot: '/fixture', providerId: 'grok-subscription'
    });
    const claim = repository.claimPrompt(created.appSessionId);
    let running = true;
    const { host, ipc } = hostHarness();
    host.sessions = repository;
    host.knownSessionIds = new Set([created.appSessionId]);
    host.runtimeGeneration = 33;
    host.sessionLoadGeneration = 0;
    host.phase = 'ready';
    host.intentionalStop = false;
    host.disposed = false;
    host.loadedSessionIds = new Set([created.appSessionId]);
    host.activePrompts = new Map([[created.appSessionId, { cancel: async () => undefined }]]);
    host.promptClaimTokens = new Map([[created.appSessionId, claim.token]]);
    host.pendingPromptTerminals = new Map();
    host.pendingPermissions = new Map();
    host.acp = undefined;
    host.supervisor = {
        get running() { return running; },
        stop: async () => { throw new SidecarTerminationUnconfirmedError(); }
    };
    host.emitSnapshot = () => undefined;

    host.runtimeFailed(new Error('fixture crash'), 33);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(repository.get(created.appSessionId)?.status, 'running');
    assert.equal(host.sidecarTerminationFences.has(created.appSessionId), true);
    assert.equal(ipc.filter(event => event.kind === 'error'
        && event.code === 'SIDECAR_TERMINATION_UNCONFIRMED').length, 1);

    running = false;
    host.runtimeFailed(new Error('late confirmed exit'), 33);
    assert.equal(host.sidecarTerminationFences.has(created.appSessionId), false);
    assert.equal(repository.get(created.appSessionId)?.status, 'failed');
});

test('ordinary cancel stays fenced through delivery and transport failure until sidecar exit', async t => {
    for (const scenario of ['delivered', 'write-failure', 'timeout']) {
        await t.test(scenario, async () => {
            const harness = hostHarness();
            let record = { ...session('a'), providerRuntimeEpoch: 'legacy-v1' };
            let claimToken;
            let starts = 0;
            let rejectPrompt;
            const prompt = new Promise((_resolve, reject) => { rejectPrompt = reject; });
            let resolveCancellation;
            let rejectCancellation;
            const cancellationDelivery = new Promise((resolve, reject) => {
                resolveCancellation = resolve;
                rejectCancellation = reject;
            });
            let running = true;
            let confirmExit;
            const stopped = new Promise(resolve => { confirmExit = resolve; });
            harness.host.phase = 'ready';
            harness.host.workspaceRoot = '/fixture';
            harness.host.providerId = 'grok-subscription';
            harness.host.runtimeProviderEpoch = 'legacy-v1';
            harness.host.selectedModel = undefined;
            harness.host.models = [];
            harness.host.capabilities = { prompt: { image: false } };
            harness.host.loadedSessionIds = new Set(['a']);
            harness.host.activePrompts = new Map();
            harness.host.activeTurnIds = new Map();
            harness.host.pendingPermissions = new Map();
            harness.host.sessions.get = () => record;
            harness.host.sessions.update = (_id, patch) => (record = { ...record, ...patch });
            harness.host.sessions.claimPrompt = (_id, validate) => {
                validate(record);
                claimToken = `claim-${scenario}`;
                record = { ...record, status: 'running' };
                return { record, token: claimToken };
            };
            harness.host.sessions.finishPrompt = (_id, token, status) => {
                assert.equal(token, claimToken);
                claimToken = undefined;
                record = { ...record, status };
                return record;
            };
            harness.host.providers = {
                selectedProviderId: () => 'grok-subscription',
                runtimeEpoch: () => 'legacy-v1',
                preferredModelId: () => undefined,
                get: providerId => ({ id: providerId, name: 'Grok Subscription', kind: 'grok-subscription' })
            };
            harness.host.acp = {
                startRequest: () => {
                    starts += 1;
                    return {
                        promise: prompt,
                        cancel: () => {
                            rejectPrompt(Object.assign(new Error('cancelled locally'), { kind: 'cancelled' }));
                            return cancellationDelivery;
                        }
                    };
                }
            };
            harness.host.supervisor = {
                get running() { return running; },
                stop: () => stopped
            };
            harness.host.deleteCancellationTimeoutMs = () => 50;
            harness.host.emitSnapshot = () => undefined;

            const sending = harness.host.sendPrompt({ sessionId: 'a', text: `cancel ${scenario}` });
            for (let attempt = 0; attempt < 10 && !harness.host.activePrompts.has('a'); attempt += 1) {
                await Promise.resolve();
            }
            const cancelling = harness.host.cancel('a');
            const receipt = await sending;
            assert.equal(receipt.outcome, 'cancelled');
            assert.equal(starts, 1);
            assert.equal(record.status, 'running', 'local prompt rejection must not release CAS before delivery authority');
            assert.equal(claimToken, `claim-${scenario}`);
            assert.equal(harness.host.sidecarTerminationFences.has('a'), true);
            await assert.rejects(harness.host.deleteSession('a'), /still confirming/);
            assert.throws(
                () => harness.host.claimPromptRecord('a', () => undefined),
                /still confirming/
            );

            if (scenario === 'delivered') {
                resolveCancellation();
                await cancelling;
                assert.equal(harness.host.phase, 'ready');
            } else {
                if (scenario === 'write-failure') {
                    rejectCancellation(new AcpWriteError({ cause: new Error('stdin closed') }));
                    await assert.rejects(cancelling, /Failed to write/);
                } else {
                    await assert.rejects(cancelling, /发送超时/);
                }
                assert.equal(harness.host.phase, 'crashed');
                assert.equal(harness.host.sidecarTerminationFences.has('a'), true);
                assert.equal(harness.host.uncertainPromptCancellations.has('a'), true);
                assert.equal(record.status, 'running');
                running = false;
                confirmExit();
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.equal(harness.host.sidecarTerminationFences.has('a'), false);
            assert.equal(harness.host.uncertainPromptCancellations.has('a'), false);
            assert.equal(record.status, 'cancelled');
            assert.equal(claimToken, undefined);
            assert.equal(starts, 1, 'termination recovery must never replay the prompt');
        });
    }
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
    const terminalTimer = setTimeout(() => undefined, 31_000);
    terminalTimer.unref();
    host.pendingPromptTerminals = new Map([['a', {
        token: 'claim-a', status: 'failed', attempts: 6, retryable: true, timer: terminalTimer
    }]]);

    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'goodbye' });
    host.disposeSync();

    assert.deepEqual(ipc.map(event => event.kind), ['text-delta']);
    assert.equal(ipc[0].text, 'goodbye');
    assert.deepEqual(lifecycle, ['sidecar-stop', 'history-dispose']);
    assert.equal(host.pendingAssistantTextDeltas.size, 0);
    assert.equal(host.pendingPromptTerminals.size, 0);
    assert.equal(terminalTimer._destroyed, true, 'disposeSync must clear the unref final retry timer');
});
