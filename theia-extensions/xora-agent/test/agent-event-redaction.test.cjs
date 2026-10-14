const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { redactAgentHostEvent } = require('../lib/electron-main/agent-event-redaction');
const { deepRedact, AgentSessionRepository } = require('../lib/electron-main/session-repository');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

const appSessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '11111111-1111-4111-8111-111111111112';
const epoch = '11111111-1111-4111-8111-111111111113';
const timestamp = '2026-10-14T11:11:11.000Z';
function session() {
    return {
        appSessionId, acpSessionId: 'upstream-1', providerId: 'xora-model-1',
        providerRuntimeEpoch: epoch, workspaceRoot: '/fixture/project-1',
        model: 'model-1', reasoningEffort: 'level-1', currentModeId: 'mode-1',
        availableModes: [{ id: 'mode-1', name: 'Mode 1', description: 'Description 1' }],
        title: 'Secret 1', createdAt: timestamp, updatedAt: timestamp, status: 'read-only'
    };
}

for (const secret of ['1', '-']) {
    test(`exact credential ${JSON.stringify(secret)} cannot corrupt live routing or durable history`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-event-redaction-'));
        const record = session();
        fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schemaVersion: 1, sessions: [record] }));
        const repository = new AgentSessionRepository(root);
        const host = Object.create(GrokAgentHostService.prototype);
        const emitted = [];
        host.sessions = repository;
        host.currentSecrets = [secret];
        host.knownSessionIds = new Set([appSessionId]);
        host.activeTurnIds = new Map([[appSessionId, turnId]]);
        host.client = { onAgentEvent: event => emitted.push(event) };
        try {
            host.emit({ kind: 'text-delta', sessionId: appSessionId, role: 'user', text: `credential=${secret}` });
            host.emit({ kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text: `answer=${secret}` });
            host.emit({ kind: 'turn-completed', sessionId: appSessionId, stopReason: 'end_turn' });
            repository.flushEvents(appSessionId);
            assert.deepEqual(emitted.map(event => event.kind), ['text-delta', 'text-delta', 'turn-completed']);
            for (const event of emitted) {
                assert.equal(event.sessionId, appSessionId);
                assert.equal(event.turnId, turnId);
            }
            assert.equal(emitted[0].text, 'credential=[REDACTED]');
            assert.equal(emitted[1].text, 'answer=[REDACTED]');
            const file = path.join(root, `${appSessionId}.jsonl`);
            assert.ok(fs.existsSync(file), 'the exact unmodified local id must route the event to JSONL');
            assert.equal(repository.readEvents(appSessionId).length, 3);
            assert.deepEqual(await host.getSessionHistory(appSessionId), emitted);
            assert.deepEqual((await host.getSessionHistoryPage(appSessionId)).events, emitted);
            assert.equal(host.persistedPlanObjective(record, turnId), 'credential=[REDACTED]');
            const reopened = new AgentSessionRepository(root);
            try { assert.deepEqual(reopened.readEvents(appSessionId), emitted); } finally { reopened.dispose(); }
        } finally {
            repository.dispose();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('session and snapshot projection retains local RPC addresses, workspace and selection values', () => {
    const record = session();
    const snapshot = {
        phase: 'auth-required', workspaceRoot: record.workspaceRoot, workspaceAttached: true,
        workspaceTrusted: true, providerId: record.providerId, activeSessionId: appSessionId,
        selectedModel: 'model-1', selectedReasoningEffort: 'level-1', preferredReasoningEffort: 'level-1',
        permissionMode: 'request-approval', grokSubscriptionAuthStatus: 'unauthenticated',
        message: 'https://example.invalid/?key=1', sessions: [record],
        sessionContexts: { [appSessionId]: { modelId: 'model-1', compactionStatus: 'idle', compactionCount: 1 } },
        models: [{ id: 'model-1', name: 'Model 1', reasoningOptions: [{ id: 'level-1', value: 'level-1', name: 'Level 1' }] }],
        capabilities: { authMethods: [{ id: 'auth-1', name: 'Auth 1' }], defaultAuthMethodId: 'auth-1' },
        metadata: { sessionId: '1', workspaceRoot: '1', providerId: '1', model: '1' }
    };
    for (const secret of ['1', '-']) {
        const original = structuredClone(snapshot);
        const safe = redactAgentHostEvent({ kind: 'snapshot', snapshot }, [secret]).snapshot;
        assert.equal(safe.phase, 'auth-required');
        assert.equal(safe.activeSessionId, appSessionId);
        assert.equal(safe.workspaceRoot, record.workspaceRoot);
        assert.equal(safe.providerId, record.providerId);
        assert.equal(safe.selectedModel, 'model-1');
        assert.equal(safe.models[0].id, 'model-1');
        assert.equal(safe.models[0].reasoningOptions[0].value, 'level-1');
        assert.equal(safe.capabilities.authMethods[0].id, 'auth-1');
        assert.equal(safe.permissionMode, 'request-approval');
        assert.equal(safe.sessions[0].appSessionId, appSessionId);
        assert.equal(safe.sessions[0].providerRuntimeEpoch, epoch);
        assert.equal(safe.sessions[0].status, 'read-only');
        assert.equal(safe.sessions[0].createdAt, timestamp);
        assert.equal(safe.sessions[0].availableModes[0].id, 'mode-1');
        assert.equal(safe.sessions[0].title, deepRedact(record.title, [secret]));
        assert.equal(safe.message, deepRedact(snapshot.message, [secret]));
        assert.deepEqual(safe.metadata, deepRedact(snapshot.metadata, [secret]));
        assert.deepEqual(snapshot, original, 'redaction must not mutate authoritative host state');
        assert.deepEqual(redactAgentHostEvent({ kind: 'session', session: record }, [secret]).session, safe.sessions[0]);
    }
});

test('a payload cannot bypass secret redaction by copying the host schema or reserved field names', () => {
    const secret = '1';
    const payload = {
        sessionId: secret, appSessionId: secret, turnId: secret, providerRuntimeEpoch: secret,
        kind: secret, role: secret, workspaceRoot: secret, model: secret, requestId: secret,
        snapshot: { activeSessionId: secret, models: [{ id: secret }] },
        authorization: 'unexpected', nested: [{ session: { appSessionId: secret } }],
        url: `https://example.invalid/?key=${secret}`
    };
    const event = {
        kind: 'tool-call', sessionId: appSessionId, turnId,
        toolCallId: `opaque-${secret}`, toolName: secret, title: secret,
        input: payload, output: JSON.stringify(payload), status: 'running', startedAt: timestamp,
        presentation: { action: 'file-read', source: 'mcp', targetLabel: secret, sourceLabel: secret, operationLabel: secret }
    };
    const safe = redactAgentHostEvent(event, [secret]);
    assert.deepEqual(safe.input, deepRedact(payload, [secret]));
    assert.equal(safe.output, deepRedact(event.output, [secret]));
    assert.equal(safe.toolCallId, 'opaque-[REDACTED]');
    assert.equal(safe.toolName, '[REDACTED]');
    assert.equal(safe.presentation.targetLabel, '[REDACTED]');
    assert.equal(safe.sessionId, appSessionId);
    assert.equal(safe.startedAt, timestamp);
    const hyphen = redactAgentHostEvent(event, ['-']);
    assert.equal(hyphen.kind, 'tool-call');
    assert.equal(hyphen.presentation.action, 'file-read');
    const invalidEnum = redactAgentHostEvent({ ...event, status: secret, presentation: { action: secret, source: secret } }, [secret]);
    assert.equal(invalidEnum.status, '[REDACTED]');
    assert.equal(invalidEnum.presentation.action, '[REDACTED]');
});

test('permission and error events retain host-generated request/group ids while hiding secrets', () => {
    const permission = redactAgentHostEvent({
        kind: 'permission-request', sessionId: appSessionId, turnId, requestId: turnId,
        title: 'https://example.invalid/1', detail: 'credential=1', options: ['allow-once', 'allow-always', 'reject']
    }, ['1', '-']);
    assert.equal(permission.requestId, turnId);
    assert.equal(permission.detail, 'credential=[REDACTED]');
    assert.deepEqual(permission.options, ['allow-once', 'allow-always', 'reject']);
    const error = redactAgentHostEvent({ kind: 'error', sessionId: appSessionId,
        errorGroupId: turnId, code: 'ERROR', message: 'credential=1', recoverable: true }, ['1']);
    assert.equal(error.errorGroupId, turnId);
    assert.equal(error.message, 'credential=[REDACTED]');
});

test('goal and plan protocol states survive punctuation credentials without exposing objectives', () => {
    const goal = redactAgentHostEvent({
        kind: 'goal-state', sessionId: appSessionId, turnId, providerRuntimeEpoch: epoch,
        goalId: 'goal-1', objective: 'secret-1', status: 'budget-limited', phase: 'executing',
        agentTurnStatus: 'end-turn', verificationStatus: 'not-required',
        tokenBudget: 100, tokensUsed: 1, elapsedMs: 1, workerRounds: 1, verificationRounds: 1,
        planning: false, verifying: false
    }, ['1', '-']);
    assert.equal(goal.status, 'budget-limited');
    assert.equal(goal.agentTurnStatus, 'end-turn');
    assert.equal(goal.verificationStatus, 'not-required');
    assert.equal(goal.tokenBudget, 100);
    assert.equal(goal.providerRuntimeEpoch, epoch);
    assert.equal(goal.objective, 'secret[REDACTED][REDACTED]');
    const plan = redactAgentHostEvent({ kind: 'plan', sessionId: appSessionId,
        entries: [{ id: 'opaque-1', text: 'secret-1', status: 'in-progress' }], providerRuntimeEpoch: epoch }, ['1', '-']);
    assert.equal(plan.entries[0].status, 'in-progress');
    assert.equal(plan.entries[0].text, 'secret[REDACTED][REDACTED]');
});

test('ordinary long credentials and unknown future payloads remain fail-closed', () => {
    const secret = `xai-${'s'.repeat(40)}`;
    const safe = redactAgentHostEvent({ kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text: secret }, [secret]);
    assert.equal(safe.text, '[REDACTED]');
    const unknown = { kind: 'future-1', sessionId: '1', input: { appSessionId: '1' } };
    assert.deepEqual(redactAgentHostEvent(unknown, ['1']), deepRedact(unknown, ['1']));
});

// Older hosts and focused lifecycle harnesses can send partial snapshots.
test('partial lifecycle snapshots retain their shape and do not require model/session arrays', () => {
    const event = { kind: 'snapshot', snapshot: { phase: 'auth-required', message: 'credential=1' } };
    assert.deepEqual(redactAgentHostEvent(event, ['1', '-']), {
        kind: 'snapshot', snapshot: { phase: 'auth-required', message: 'credential=[REDACTED]' }
    });
});

test('sendPrompt admits one durable redacted user turn and keeps the session reusable with short credentials', async t => {
    for (const secret of ['1', '-']) {
        await t.test(JSON.stringify(secret), async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-short-secret-prompt-'));
            const record = { ...session(), providerId: 'grok-subscription', status: 'idle' };
            delete record.model;
            delete record.reasoningEffort;
            delete record.currentModeId;
            delete record.availableModes;
            fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schemaVersion: 1, sessions: [record] }));
            const repository = new AgentSessionRepository(root);
            const host = Object.create(GrokAgentHostService.prototype);
            const emitted = [];
            Object.assign(host, {
                sessions: repository, currentSecrets: [secret], knownSessionIds: new Set([appSessionId]),
                client: { onAgentEvent: event => emitted.push(event) }, phase: 'ready',
                workspaceRoot: record.workspaceRoot, providerId: record.providerId, runtimeProviderEpoch: epoch,
                models: [], capabilities: { prompt: { image: false } }, loadedSessionIds: new Set([appSessionId]),
                activePrompts: new Map(), activeTurnIds: new Map(), providers: {
                    selectedProviderId: () => record.providerId, runtimeEpoch: () => epoch,
                    preferredModelId: () => undefined,
                    get: providerId => ({ id: providerId, name: 'Fixture', kind: 'grok-subscription' })
                }
            });
            let promptCount = 0;
            host.acp = { startRequest: (method, params) => {
                assert.equal(method, 'session/prompt');
                assert.equal(params.sessionId, record.acpSessionId, 'only the real upstream session id addresses ACP');
                const stored = fs.readFileSync(path.join(root, `${appSessionId}.jsonl`), 'utf8')
                    .trim().split('\n').map(line => JSON.parse(line).event);
                const latestUser = stored.findLast(event => event.kind === 'text-delta' && event.role === 'user');
                assert.equal(latestUser.sessionId, appSessionId);
                assert.equal(latestUser.text, 'credential=[REDACTED]');
                promptCount++;
                host.emit({ kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text: `answer=${secret}` });
                return { promise: Promise.resolve({ stopReason: 'end_turn' }), cancel: async () => undefined };
            } };
            try {
                const first = await host.sendPrompt({ sessionId: appSessionId, text: `credential=${secret}` });
                const second = await host.sendPrompt({ sessionId: appSessionId, text: `credential=${secret}` });
                assert.equal(first.admitted, true);
                assert.equal(first.outcome, 'completed');
                assert.equal(second.outcome, 'completed');
                assert.notEqual(first.turnId, second.turnId);
                assert.equal(promptCount, 2, 'each explicit send crosses ACP exactly once');
                assert.equal(repository.get(appSessionId).status, 'completed');
                const history = await host.getSessionHistory(appSessionId);
                assert.equal(history.filter(event => event.kind === 'text-delta' && event.role === 'user').length, 2);
                assert.equal(history.filter(event => event.kind === 'text-delta' && event.role === 'assistant').length, 2);
                assert.equal(history.filter(event => event.kind === 'turn-completed').length, 2);
                assert.ok(history.every(event => event.sessionId === appSessionId));
                assert.ok(history.filter(event => event.kind === 'text-delta').every(event => event.text.endsWith('[REDACTED]')));
                assert.equal(emitted.some(event => event.kind === 'error'), false);
            } finally {
                repository.dispose();
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
