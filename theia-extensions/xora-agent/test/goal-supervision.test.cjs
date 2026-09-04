const assert = require('node:assert/strict');
const test = require('node:test');
const { AcpWriteError } = require('@xora-code/acp-client');

const { AgentViewModel } = require('../lib/browser/agent-view-model');
const {
    GrokAgentHostService,
    buildSupervisionShadowEvent,
    formatAgentWirePrompt,
    formatContinuousGoalPrompt,
    parseGoalUpdated
} = require('../lib/electron-main/grok-agent-host-service');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function session(overrides = {}) {
    return {
        appSessionId: 'app-a',
        acpSessionId: 'acp-a',
        title: 'A',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'epoch-a',
        model: 'grok',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
        status: 'idle',
        currentModeId: 'plan',
        availableModes: [
            { id: 'default', name: 'Agent' },
            { id: 'plan', name: 'Plan' }
        ],
        ...overrides
    };
}

function hostHarness(handles = []) {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session();
    const persisted = [];
    const delivered = [];
    const requests = [];
    const provider = { id: 'grok-subscription', kind: 'grok-subscription', name: 'Grok subscription' };

    host.phase = 'ready';
    host.workspaceRoot = '/fixture';
    host.providerId = provider.id;
    host.runtimeProviderEpoch = 'epoch-a';
    host.selectedModel = undefined;
    host.currentSecrets = [];
    host.providerDefaultsRefreshPending = false;
    host.mcpConfigurationRefreshPending = false;
    host.skillsRefreshPending = false;
    host.loadedSessionIds = new Set([record.appSessionId]);
    host.knownSessionIds = new Set([record.appSessionId]);
    host.activePrompts = new Map();
    host.activeTurnIds = new Map();
    host.activePromptObjectives = new Map();
    host.goalCompletionSignals = new Map();
    host.pendingApprovedPlans = new Map();
    host.pendingPlanApprovals = new Map();
    host.sessionGoalStates = new Map();
    host.sessionPlans = new Map();
    host.supervisionTurnSignals = new Map();
    host.acpGoalCapabilities = new Map([[
        record.acpSessionId,
        { available: true, command: true, updateTool: true }
    ]]);
    host.acpSessionLookup = new Map([[record.acpSessionId, record.appSessionId]]);
    host.restoringSessionCounts = new Map();
    host.pendingAssistantTextDeltas = new Map();
    host.assistantStreamsStarted = new Set();
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (id, patch) => {
            assert.equal(id, record.appSessionId);
            record = { ...record, ...patch };
            return record;
        },
        appendEvent: (id, event) => persisted.push({ id, event }),
        flushEvents: () => undefined
    };
    host.providers = {
        get: id => id === provider.id ? provider : undefined,
        selectedProviderId: () => provider.id,
        runtimeEpoch: () => 'epoch-a',
        preferredModelId: () => undefined
    };
    host.client = { onAgentEvent: event => delivered.push(event) };
    host.acp = {
        startRequest(method, params, options) {
            requests.push({ method, params, options });
            const next = handles.shift() ?? { promise: Promise.resolve({ stopReason: 'end_turn' }) };
            return {
                promise: next.promise,
                cancel: next.cancel ?? (async () => undefined)
            };
        }
    };
    host.withCurrentIntegrationRead = async (_root, operation) => operation({});
    host.acceptPromptContextFallback = () => undefined;
    host.acceptContextTotal = () => undefined;
    host.clearToolActivityTimings = () => undefined;
    host.emitError = (code, error, recoverable, sessionId) => host.emit({
        kind: 'error',
        sessionId,
        code,
        message: error instanceof Error ? error.message : String(error),
        recoverable
    });

    return {
        host,
        persisted,
        delivered,
        requests,
        record: () => record
    };
}

function restoreHarness(options = {}) {
    let record = session({
        status: 'failed',
        sidecarVersion: '0.2.102',
        goalCapability: { available: true, command: true, updateTool: true },
        ...options.record
    });
    const history = [...(options.history ?? [])];
    const delivered = [];
    const requests = [];
    const goalHandles = [];
    const provider = { id: 'grok-subscription', kind: 'grok-subscription', name: 'Grok subscription' };
    const host = Object.create(GrokAgentHostService.prototype);

    host.phase = 'ready';
    host.workspaceRoot = record.workspaceRoot;
    host.providerId = record.providerId;
    host.runtimeProviderEpoch = record.providerRuntimeEpoch;
    host.sidecarVersion = '0.2.102';
    host.runtimeGeneration = 7;
    host.sessionLoadGeneration = 0;
    host.selectedModel = undefined;
    host.models = [];
    host.currentSecrets = [];
    host.loadedSessionIds = new Set();
    host.knownSessionIds = new Set([record.appSessionId]);
    host.pendingSessionLoads = new Map();
    host.activePrompts = new Map();
    host.activeTurnIds = new Map();
    host.activePromptObjectives = new Map();
    host.goalCompletionSignals = new Map();
    host.pendingApprovedPlans = new Map();
    host.pendingPlanApprovals = new Map();
    host.sessionGoalStates = new Map();
    host.sessionPlans = new Map();
    host.sessionTaskContracts = new Map();
    host.replayedGoalStates = new Map();
    host.supervisionTurnSignals = new Map();
    host.acpGoalCapabilities = new Map([[
        record.acpSessionId,
        { available: true, command: true, updateTool: true }
    ]]);
    host.acpSessionLookup = new Map([[record.acpSessionId, record.appSessionId]]);
    host.restoringSessionCounts = new Map();
    host.contextEventHighwaters = new Map();
    host.pendingAssistantTextDeltas = new Map();
    host.assistantStreamsStarted = new Set();
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (id, patch) => {
            assert.equal(id, record.appSessionId);
            record = { ...record, ...patch };
            return record;
        },
        readEvents: id => id === record.appSessionId ? [...history] : [],
        appendEvent: (id, event) => {
            assert.equal(id, record.appSessionId);
            history.push(event);
        },
        flushEvents: () => undefined
    };
    host.providers = {
        get: id => id === provider.id ? provider : undefined,
        list: () => [provider],
        selectedProviderId: () => provider.id,
        runtimeEpoch: () => 'epoch-a',
        preferredModelId: () => undefined
    };
    host.client = { onAgentEvent: event => delivered.push(event) };
    host.acceptModelState = () => undefined;
    host.acceptRuntimeMcpSnapshot = () => undefined;
    host.scheduleMcpStatusRefresh = () => undefined;
    host.emitSnapshot = () => undefined;
    host.clearToolActivityTimings = () => undefined;
    host.acceptPromptContextFallback = () => undefined;
    host.acceptContextTotal = () => undefined;
    host.notifyProviderDefaultsChanged = () => undefined;
    host.withCurrentIntegrationRead = async (_root, operation) => operation({ mcpServers: [] });
    host.emitError = (code, error, recoverable, sessionId) => host.emit({
        kind: 'error',
        sessionId,
        code,
        message: error instanceof Error ? error.message : String(error),
        recoverable
    });
    host.acp = {
        async request(method, params, requestOptions) {
            requests.push({ method, params, options: requestOptions });
            if (options.onRequest) return options.onRequest({ host, method, params, requestOptions, delivered });
            return {
                modes: {
                    currentModeId: 'default',
                    availableModes: [
                        { id: 'default', name: 'Agent' },
                        { id: 'plan', name: 'Plan' }
                    ]
                }
            };
        },
        startRequest(method, params, requestOptions) {
            requests.push({ method, params, options: requestOptions });
            if (options.startRequest) return options.startRequest({ host, method, params, requestOptions });
            const completion = deferred();
            goalHandles.push(completion);
            return { promise: completion.promise, cancel: async () => undefined };
        },
        async notify(method, params) {
            requests.push({ method, params, notification: true });
            if (options.onNotify) return options.onNotify({ host, method, params });
        }
    };

    return { host, history, delivered, requests, goalHandles, record: () => record };
}

function installDurablePromptClaims(harness) {
    let token;
    harness.host.promptClaimTokens = new Map();
    harness.host.sessions.claimPrompt = (appSessionId, validate) => {
        const current = harness.record();
        validate(current);
        assert.notEqual(current.status, 'running');
        token = `claim-${appSessionId}`;
        const running = harness.host.sessions.update(appSessionId, { status: 'running' });
        return { record: running, token };
    };
    harness.host.sessions.finishPrompt = (appSessionId, candidate, status) => {
        assert.equal(candidate, token);
        token = undefined;
        return harness.host.sessions.update(appSessionId, { status });
    };
    harness.host.sessions.promptClaimOwnership = () => token ? 'owned' : 'none';
    return { token: () => token };
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(message);
}

function approvalContract() {
    return {
        objective: '实现持续完成并验证结果',
        planEntries: [
            { id: 'plan-1', text: '实现功能' },
            { id: 'plan-2', text: '运行测试' }
        ],
        acceptanceCriteria: ['测试通过', '检查最终差异']
    };
}

function goalState(overrides = {}) {
    return {
        kind: 'goal-state',
        sessionId: 'app-a',
        goalId: 'goal-a',
        objective: '完成并验证目标',
        status: 'active',
        phase: 'executing',
        agentTurnStatus: 'running',
        verificationStatus: 'working',
        tokensUsed: 100,
        elapsedMs: 20,
        workerRounds: 1,
        verificationRounds: 0,
        planning: false,
        verifying: false,
        providerRuntimeEpoch: 'epoch-a',
        ...overrides
    };
}

function taskContract(overrides = {}) {
    return {
        kind: 'task-contract',
        sessionId: 'app-a',
        objective: '完成并验证目标',
        planEntries: [{ id: 'plan-1', text: '实现目标' }],
        acceptanceCriteria: ['测试通过'],
        goalId: 'goal-a',
        approvedAt: '2026-07-31T00:00:00.000Z',
        lifecycle: 'goal-active',
        updatedAt: '2026-07-31T00:00:01.000Z',
        providerRuntimeEpoch: 'epoch-a',
        ...overrides
    };
}

async function approveCurrentPlan(harness) {
    const response = harness.host.handlePlanApprovalRequest({
        sessionId: 'acp-a',
        toolCallId: 'exit-plan-1',
        planContent: '1. 实现功能\n2. 运行测试'
    });
    await waitFor(
        () => harness.delivered.some(event => event.kind === 'plan-approval-request'),
        'Plan approval request should be delivered to the renderer'
    );
    const event = harness.delivered.find(item => item.kind === 'plan-approval-request');
    let reverseSettled = false;
    void response.then(() => { reverseSettled = true; });
    await assert.rejects(harness.host.respondPlanApproval({
        requestId: event.requestId,
        outcome: 'approved',
        contract: { ...event.suggestedContract, acceptanceCriteria: [] }
    }), /between 1 and 100 acceptance criteria/);
    await Promise.resolve();
    assert.equal(reverseSettled, false, 'invalid criteria must leave the native reverse request parked');
    assert.equal(
        harness.requests.filter(request => request.params.prompt?.[0]?.text?.startsWith('/goal ')).length,
        0,
        'invalid renderer approval must not start Goal'
    );
    await assert.rejects(harness.host.respondPlanApproval({
        requestId: event.requestId,
        outcome: 'approved',
        contract: {
            objective: 'renderer 伪造目标',
            planEntries: [{ id: 'forged-step', text: 'renderer 伪造步骤' }],
            acceptanceCriteria: ['伪造条件']
        }
    }), /do not match/,
    'renderer must not replace Electron-owned objective or Plan steps');
    await harness.host.respondPlanApproval({
        requestId: event.requestId,
        outcome: 'approved',
        contract: {
            ...event.suggestedContract,
            acceptanceCriteria: approvalContract().acceptanceCriteria
        }
    });
    assert.deepEqual(await response, { outcome: 'approved' });
    return event;
}

test('goal_updated is parsed into separate Agent-turn and Xora-verification state and persisted', () => {
    const parsed = parseGoalUpdated({
        sessionUpdate: 'goal_updated',
        goal_id: 'goal-42',
        objective: '完成并验证桌面功能',
        status: 'active',
        phase: 'executing',
        tokens_used: 1234,
        elapsed_ms: 5678,
        total_worker_rounds: 2,
        total_verify_rounds: 1,
        classifier_runs_attempted: 1,
        classifier_max_runs: 3,
        last_classifier_verdict: 'not_achieved',
        verifying_completion: true,
        last_event: 'verification_started'
    }, {
        sessionId: 'app-a',
        turnId: 'turn-a',
        agentTurnStatus: 'end-turn',
        providerRuntimeEpoch: 'epoch-a'
    });
    assert.equal(parsed.agentTurnStatus, 'end-turn');
    assert.equal(parsed.verificationStatus, 'verifying');
    assert.equal(parsed.classifierVerdict, 'not-achieved');
    assert.equal(parsed.turnId, 'turn-a');

    const harness = hostHarness();
    harness.host.activeTurnIds.set('app-a', 'turn-a');
    harness.host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'goal_updated',
            goal_id: 'goal-42',
            objective: '完成并验证桌面功能',
            status: 'complete',
            phase: 'idle',
            tokens_used: 2000,
            elapsed_ms: 9000,
            total_worker_rounds: 3,
            total_verify_rounds: 2,
            last_classifier_verdict: 'achieved'
        }
    }, 'x.ai/session_notification');

    const persistedGoal = harness.persisted.find(({ event }) => event.kind === 'goal-state')?.event;
    assert.ok(persistedGoal, 'goal state should be appended to the session JSONL stream');
    assert.equal(persistedGoal.status, 'complete');
    assert.equal(persistedGoal.agentTurnStatus, 'end-turn');
    assert.equal(persistedGoal.verificationStatus, 'verified');
    assert.equal(persistedGoal.providerRuntimeEpoch, 'epoch-a');
});

test('native Goal capability is authoritative per ACP session and never leaks between conversations', () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const records = new Map([
        ['app-a', session({ appSessionId: 'app-a', acpSessionId: 'acp-a', goalCapability: undefined })],
        ['app-b', session({ appSessionId: 'app-b', acpSessionId: 'acp-b', goalCapability: undefined })]
    ]);
    host.loadedSessionIds = new Set(records.keys());
    host.acpGoalCapabilities = new Map();
    host.sessions = {
        get: id => records.get(id),
        list: () => [...records.values()],
        update: (id, patch) => {
            const updated = { ...records.get(id), ...patch };
            records.set(id, updated);
            return updated;
        }
    };
    host.emit = () => undefined;

    host.acceptAvailableCommands('acp-a', 'app-a', {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'goal' }],
        _meta: { tools: ['update_goal'] }
    }, false);
    host.acceptAvailableCommands('acp-b', 'app-b', {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help' }],
        _meta: { tools: [] }
    }, false);

    assert.deepEqual(records.get('app-a').goalCapability, {
        available: true,
        command: true,
        updateTool: true
    });
    assert.deepEqual(records.get('app-b').goalCapability, {
        available: false,
        command: false,
        updateTool: false
    });
    assert.equal(host.sessionSupportsGoal('app-a'), true);
    assert.equal(host.sessionSupportsGoal('app-b'), false);

    // Re-advertising an unsupported B must not downgrade or borrow A's state.
    host.acceptAvailableCommands('acp-b', 'app-b', {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
        _meta: { tools: [] }
    }, false);
    assert.equal(host.sessionSupportsGoal('app-a'), true);
    assert.equal(host.sessionSupportsGoal('app-b'), false);
});

test('consecutive Plan turns never reuse an earlier turn plan when the current update is absent or late', async () => {
    const harness = hostHarness();
    harness.host.activeTurnIds.set('app-a', 'plan-turn-1');
    harness.host.activePromptObjectives.set('app-a', '第一轮目标');
    harness.host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'plan',
            title: '第一轮计划',
            entries: [{ id: 'first-only', content: '第一轮步骤', status: 'in_progress' }]
        }
    });
    assert.equal(harness.host.sessionPlanState().get('app-a').turnId, 'plan-turn-1');
    assert.equal(
        harness.persisted.filter(({ event }) => event.kind === 'plan').at(-1).event.turnId,
        'plan-turn-1',
        'in-memory and persisted Plan state must use the same turn identity'
    );

    harness.host.activeTurnIds.set('app-a', 'plan-turn-2');
    harness.host.activePromptObjectives.set('app-a', '第二轮目标');
    const response = harness.host.handlePlanApprovalRequest({
        sessionId: 'acp-a',
        toolCallId: 'second-exit-plan',
        planContent: '1. 第二轮步骤 A\n2. 第二轮步骤 B'
    });
    await waitFor(
        () => harness.delivered.some(event => event.kind === 'plan-approval-request'),
        'second Plan approval should be shown'
    );
    const approval = harness.delivered.filter(event => event.kind === 'plan-approval-request').at(-1);
    assert.equal(approval.suggestedContract.objective, '第二轮目标');
    assert.deepEqual(
        approval.suggestedContract.planEntries.map(entry => entry.text),
        ['第二轮步骤 A', '第二轮步骤 B']
    );
    assert.equal(approval.suggestedContract.planEntries.some(entry => entry.id === 'first-only'), false);
    await harness.host.respondPlanApproval({ requestId: approval.requestId, outcome: 'cancelled' });
    assert.deepEqual(await response, { outcome: 'cancelled' });
});

test('Plan mode rejects non-read-only permission even in full access while normal Agent mode is unchanged', async () => {
    const harness = hostHarness();
    harness.host.sidecarVersion = '0.2.102';
    harness.host.security = { agentPermissionMode: () => 'full-access' };
    harness.host.isWorkspaceTrusted = () => true;
    harness.host.activePrompts.set('app-a', {
        promise: new Promise(() => undefined),
        cancel: async () => undefined
    });
    const writeRequest = {
        sessionId: 'acp-a',
        toolCall: {
            toolCallId: 'write-1',
            title: 'Edit fixture',
            kind: 'edit',
            locations: [{ path: '/fixture/src/example.ts', line: 1 }],
            rawInput: { path: '/fixture/src/example.ts' },
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name: 'search_replace',
                    kind: 'edit',
                    read_only: false
                }
            }
        },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    };

    const denied = await harness.host.handlePermissionRequest(writeRequest);
    assert.deepEqual(denied, { outcome: { outcome: 'cancelled' } });

    const hostileReadOnlyClaims = [
        {
            toolCallId: 'terminal-touch',
            title: 'Pretend terminal read',
            kind: 'execute',
            rawInput: { command: 'touch /fixture/owned' },
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name: 'terminal',
                    kind: 'execute',
                    read_only: true,
                    input: { command: 'touch /fixture/owned' }
                }
            }
        },
        {
            toolCallId: 'mcp-mutate',
            title: 'Pretend MCP read',
            kind: 'use_tool',
            rawInput: { tool_name: 'unsafe-server__mutate_state' },
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name: 'use_tool',
                    namespace: 'mcp',
                    kind: 'use_tool',
                    read_only: true,
                    input: { tool_name: 'unsafe-server__mutate_state' }
                }
            }
        }
    ];
    for (const toolCall of hostileReadOnlyClaims) {
        assert.deepEqual(await harness.host.handlePermissionRequest({
            ...writeRequest,
            toolCall
        }), { outcome: { outcome: 'cancelled' } }, `${toolCall.toolCallId} must fail closed in Plan mode`);
    }

    const canonicalReadOnlyBuiltins = [
        ['read-file', 'read_file', 'read', { path: '/fixture/src/example.ts' }],
        ['project-search', 'search', 'search', { query: 'goal_updated' }],
        ['web-search', 'web_search', 'web_search', { query: 'ACP goal' }],
        ['web-fetch', 'web_fetch', 'web_fetch', { url: 'https://example.com' }],
        ['plan-update', 'update_plan', 'plan', { entries: [] }]
    ];
    for (const [toolCallId, name, kind, input] of canonicalReadOnlyBuiltins) {
        assert.deepEqual(await harness.host.handlePermissionRequest({
            ...writeRequest,
            toolCall: {
                toolCallId,
                title: name,
                kind,
                rawInput: input,
                _meta: {
                    'x.ai/tool': {
                        version: 1,
                        name,
                        kind,
                        // The canonical action, not this untrusted bit, is the
                        // Plan boundary authority.
                        read_only: false,
                        input
                    }
                }
            }
        }), {
            outcome: { outcome: 'selected', optionId: 'allow-once' }
        }, `${name} should remain usable during read-only planning`);
    }

    harness.host.sessionTaskContracts = new Map([[
        'app-a',
        taskContract({ lifecycle: 'approved', goalId: undefined })
    ]]);
    assert.deepEqual(await harness.host.handlePermissionRequest({
        ...writeRequest,
        toolCall: { ...writeRequest.toolCall, toolCallId: 'stale-approved-contract-write' }
    }), { outcome: { outcome: 'cancelled' } },
    'a durable approved/goal-active contract is history, not live write authority');

    harness.host.pendingApprovedPlanState().set('app-a', approvalContract());
    assert.deepEqual(await harness.host.handlePermissionRequest({
        ...writeRequest,
        toolCall: { ...writeRequest.toolCall, toolCallId: 'fresh-approved-plan-write' }
    }), { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    'only the fresh approval owned by this still-running Plan loop unlocks implementation writes');
    harness.host.pendingApprovedPlanState().delete('app-a');

    harness.host.sessions.update('app-a', { currentModeId: 'default' });
    const allowed = await harness.host.handlePermissionRequest({
        ...writeRequest,
        toolCall: { ...writeRequest.toolCall, toolCallId: 'write-2' }
    });
    assert.deepEqual(allowed, {
        outcome: { outcome: 'selected', optionId: 'allow-once' }
    });
});

test('a verified native Goal remains verified when cancellation or runtime failure closes the Agent turn', async t => {
    for (const agentTurnStatus of ['cancelled', 'error']) {
        await t.test(agentTurnStatus, () => {
            const harness = hostHarness();
            const goal = goalState({
                status: 'complete',
                phase: 'idle',
                verificationStatus: 'verified',
                classifierVerdict: 'achieved'
            });
            const contract = taskContract({ lifecycle: 'verified' });
            harness.host.sessionGoalStates.set('app-a', goal);
            harness.host.sessionTaskContracts = new Map([['app-a', contract]]);
            harness.host.activePrompts.set('app-a', {
                promise: new Promise(() => undefined),
                cancel: async () => undefined
            });
            harness.host.emit(goal);
            harness.host.emit(contract);

            harness.host.clearGoalRuntimeState(agentTurnStatus);

            const finalGoal = harness.persisted
                .filter(({ event }) => event.kind === 'goal-state')
                .at(-1).event;
            const finalContract = harness.persisted
                .filter(({ event }) => event.kind === 'task-contract')
                .at(-1).event;
            assert.equal(finalGoal.agentTurnStatus, agentTurnStatus);
            assert.equal(finalGoal.verificationStatus, 'verified');
            assert.equal(finalGoal.status, 'complete');
            assert.equal(finalContract.lifecycle, 'verified');
        });
    }
});

test('crash state is durable and authoritative session/load replay resumes or verifies only the same Goal contract', async t => {
    const crashed = hostHarness();
    crashed.host.sessionTaskContracts = new Map([['app-a', taskContract({ lifecycle: 'goal-active' })]]);
    crashed.host.sessionGoalStates.set('app-a', goalState());
    crashed.host.activePrompts.set('app-a', {
        promise: new Promise(() => undefined),
        cancel: async () => undefined
    });
    crashed.host.clearGoalRuntimeState('error');
    const crashEvents = crashed.persisted.map(item => item.event);
    assert.equal(crashEvents.filter(event => event.kind === 'goal-state').at(-1).agentTurnStatus, 'error');
    assert.equal(crashEvents.filter(event => event.kind === 'goal-state').at(-1).verificationStatus, 'paused');
    assert.equal(crashEvents.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'interrupted');

    await t.test('same goalId active/complete replay becomes the authoritative verified state', async () => {
        let harness;
        harness = restoreHarness({
            history: crashEvents,
            onRequest: async ({ host, method }) => {
                assert.equal(method, 'session/load');
                for (const update of [
                    { status: 'active', phase: 'executing', last_event: 'worker_resumed' },
                    { status: 'complete', phase: 'idle', last_classifier_verdict: 'achieved', last_event: 'goal_completed' }
                ]) {
                    host.acceptXaiSessionContext({
                        sessionId: 'acp-a',
                        update: {
                            sessionUpdate: 'goal_updated',
                            goal_id: 'goal-a',
                            objective: '完成并验证目标',
                            tokens_used: 200,
                            elapsed_ms: 40,
                            total_worker_rounds: 2,
                            total_verify_rounds: 1,
                            ...update
                        },
                        _meta: { isReplay: true }
                    }, 'x.ai/session_notification');
                }
                return { modes: { currentModeId: 'default', availableModes: [] } };
            }
        });
        await harness.host.getSessionHistory('app-a');
        await harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });

        const finalHistory = await harness.host.getSessionHistory('app-a');
        const finalGoal = finalHistory.filter(event => event.kind === 'goal-state').at(-1);
        const finalContract = finalHistory.filter(event => event.kind === 'task-contract').at(-1);
        assert.equal(finalGoal.status, 'complete');
        assert.equal(finalGoal.verificationStatus, 'verified');
        assert.equal(finalContract.goalId, 'goal-a');
        assert.equal(finalContract.lifecycle, 'verified');

        const model = new AgentViewModel();
        model.showSessionHistory(harness.record(), finalHistory);
        assert.equal(model.goalState('app-a').verificationStatus, 'verified');
        assert.equal(model.taskContract('app-a').lifecycle, 'verified');
    });

    await t.test('a different replayed goalId never verifies the interrupted old contract', async () => {
        const harness = restoreHarness({
            history: crashEvents,
            onRequest: async ({ host }) => {
                host.acceptXaiSessionContext({
                    sessionId: 'acp-a',
                    update: {
                        sessionUpdate: 'goal_updated',
                        goal_id: 'goal-new',
                        objective: '另一个目标',
                        status: 'complete',
                        phase: 'idle',
                        last_classifier_verdict: 'achieved'
                    },
                    _meta: { isReplay: true }
                }, 'x.ai/session_notification');
                return { modes: { currentModeId: 'default', availableModes: [] } };
            }
        });
        await harness.host.getSessionHistory('app-a');
        await harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
        const finalHistory = await harness.host.getSessionHistory('app-a');
        const finalContract = finalHistory.filter(event => event.kind === 'task-contract').at(-1);
        assert.equal(finalContract.goalId, 'goal-a');
        assert.equal(finalContract.lifecycle, 'interrupted');
        assert.equal(finalHistory.filter(event => event.kind === 'goal-state').at(-1).goalId, 'goal-new');
    });
});

test('an active-only Goal replay is projected as paused/interrupted without a phantom running handle', async () => {
    const harness = restoreHarness({
        history: [
            goalState({ agentTurnStatus: 'error', verificationStatus: 'paused' }),
            taskContract({ lifecycle: 'interrupted' })
        ],
        onRequest: async ({ host }) => {
            // No isReplay marker: session/load itself is the replay boundary.
            host.acceptXaiSessionContext({
                sessionId: 'acp-a',
                update: {
                    sessionUpdate: 'goal_updated',
                    goal_id: 'goal-a',
                    objective: '完成并验证目标',
                    status: 'active',
                    phase: 'executing',
                    last_event: 'worker_running'
                },
                _meta: { eventId: 'acp-a-1' }
            }, 'x.ai/session_notification');
            return { modes: { currentModeId: 'default', availableModes: [] } };
        }
    });
    await harness.host.getSessionHistory('app-a');
    const loaded = await harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
    const finalHistory = await harness.host.getSessionHistory('app-a');
    const finalGoal = finalHistory.filter(event => event.kind === 'goal-state').at(-1);
    const finalContract = finalHistory.filter(event => event.kind === 'task-contract').at(-1);
    assert.notEqual(loaded.status, 'running');
    assert.equal(harness.host.activePrompts.has('app-a'), false);
    assert.notEqual(finalGoal.agentTurnStatus, 'running');
    assert.equal(finalGoal.verificationStatus, 'paused');
    assert.equal(finalContract.lifecycle, 'interrupted');
    assert.deepEqual(
        harness.requests.slice(0, 2).map(request => [request.method, request.notification === true]),
        [['session/load', false], ['session/cancel', true]],
        'the orphaned native Goal must be cancelled before load returns and a later prompt can start'
    );
    assert.equal(
        harness.delivered.filter(event => event.kind === 'session' && event.session.status === 'running').length,
        0,
        'renderer must never see a running session without an owned ACP request handle'
    );
    const ordinary = harness.host.sendPrompt({ sessionId: 'app-a', text: '取消孤儿目标后继续' });
    await waitFor(
        () => harness.requests.some(request => request.method === 'session/prompt'),
        'a later prompt may start only after the cancellation notification has completed'
    );
    assert.ok(
        harness.requests.findIndex(request => request.method === 'session/cancel')
        < harness.requests.findIndex(request => request.method === 'session/prompt')
    );
    harness.goalHandles[0].resolve({ stopReason: 'end_turn' });
    await ordinary;
});

test('orphaned active Goal cancellation keeps a durable claim until delivery or real process exit', async t => {
    for (const scenario of ['delivered', 'write-failure', 'timeout']) {
        await t.test(scenario, async () => {
            const delivery = deferred();
            const stopped = deferred();
            let running = true;
            const harness = restoreHarness({
                record: { status: 'idle' },
                history: [taskContract({ lifecycle: 'interrupted' })],
                onNotify: () => delivery.promise
            });
            const claims = installDurablePromptClaims(harness);
            harness.host.deleteCancellationTimeoutMs = () => 50;
            harness.host.supervisor = {
                get running() { return running; },
                stop: () => stopped.promise
            };
            harness.host.replayedGoalStateMap().set('app-a', goalState({
                status: 'active',
                phase: 'executing',
                agentTurnStatus: 'running',
                verificationStatus: 'working'
            }));

            const publishing = harness.host.publishReplayedGoalState('app-a');
            await waitFor(
                () => harness.requests.some(request => request.method === 'session/cancel'),
                'orphan cancellation should reach its delivery fence'
            );
            assert.equal(harness.record().status, 'running');
            assert.equal(claims.token(), 'claim-app-a');
            assert.equal(harness.host.promptClaimOwnership('app-a'), 'owned');
            assert.equal(harness.host.sidecarTerminationFenceState().has('app-a'), true);
            await assert.rejects(harness.host.deleteSession('app-a'), /still confirming/);
            await assert.rejects(harness.host.loadSession('app-a'), /still confirming/);
            assert.throws(
                () => harness.host.claimPromptRecord('app-a', () => undefined),
                /still confirming/
            );
            assert.equal(
                harness.requests.some(request => request.method === 'session/prompt'),
                false,
                'orphan recovery must never replay a prompt'
            );

            if (scenario === 'delivered') {
                delivery.resolve();
                await publishing;
                assert.equal(harness.host.phase, 'ready');
            } else {
                if (scenario === 'write-failure') {
                    delivery.reject(new AcpWriteError({ cause: new Error('stdin closed') }));
                    await assert.rejects(publishing, /Failed to write/);
                } else {
                    await assert.rejects(publishing, /发送超时/);
                }
                assert.equal(harness.host.phase, 'crashed');
                assert.equal(harness.record().status, 'running');
                assert.equal(claims.token(), 'claim-app-a');
                assert.equal(harness.host.uncertainPromptCancellationState().has('app-a'), true);
                running = false;
                stopped.resolve();
                await new Promise(resolve => setImmediate(resolve));
            }

            assert.equal(harness.host.sidecarTerminationFenceState().has('app-a'), false);
            assert.equal(harness.host.uncertainPromptCancellationState().has('app-a'), false);
            assert.equal(harness.record().status, 'cancelled');
            assert.equal(claims.token(), undefined);
            assert.equal(harness.host.promptClaimOwnership('app-a'), 'none');
            assert.equal(
                harness.requests.some(request => request.method === 'session/prompt'),
                false
            );
        });
    }
});

test('unmarked session/load capability and mode notifications commit only after restore succeeds', async () => {
    let intermediateSessionEvents = -1;
    const harness = restoreHarness({
        record: {
            currentModeId: 'default',
            goalCapability: { available: false, command: false, updateTool: false }
        },
        onRequest: async ({ host, delivered }) => {
            host.acceptSessionUpdate({
                sessionId: 'acp-a',
                update: {
                    sessionUpdate: 'available_commands_update',
                    availableCommands: [{ name: 'goal' }],
                    _meta: { tools: ['update_goal'] }
                }
            });
            host.acceptSessionUpdate({
                sessionId: 'acp-a',
                update: {
                    sessionUpdate: 'current_mode_update',
                    currentModeId: 'plan'
                }
            });
            intermediateSessionEvents = delivered.filter(event => event.kind === 'session').length;
            return {
                modes: {
                    currentModeId: 'plan',
                    availableModes: [
                        { id: 'default', name: 'Agent' },
                        { id: 'plan', name: 'Plan' }
                    ]
                }
            };
        }
    });
    const loaded = await harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
    assert.equal(intermediateSessionEvents, 0, 'restore replay must not flash intermediate controls');
    assert.equal(loaded.currentModeId, 'plan');
    assert.deepEqual(loaded.goalCapability, { available: true, command: true, updateTool: true });
    const committedSessions = harness.delivered.filter(event => event.kind === 'session');
    assert.ok(committedSessions.length >= 1);
    assert.equal(committedSessions.every(event => event.session.currentModeId === 'plan'), true);
    assert.equal(committedSessions.every(event => event.session.goalCapability?.available === true), true);
});

test('live Plan approval is not persisted; approval plus Plan end_turn starts exactly one native Goal turn', async () => {
    const planTurn = deferred();
    const goalTurn = deferred();
    const harness = hostHarness([planTurn, goalTurn]);
    const sending = harness.host.sendPrompt({
        sessionId: 'app-a',
        text: '先规划一个可靠实现',
        executionMode: 'standard'
    });
    await waitFor(() => harness.requests.length === 1, 'Plan turn should start');

    const approval = await approveCurrentPlan(harness);
    assert.equal(
        harness.persisted.some(({ event }) => event.kind === 'plan-approval-request'),
        false,
        'the live reverse-request card must never enter durable history'
    );
    assert.deepEqual(
        harness.persisted
            .filter(({ event }) => event.kind === 'task-contract')
            .map(({ event }) => event.lifecycle),
        ['approved']
    );
    const approvedContractEvent = harness.persisted.find(({ event }) => event.kind === 'task-contract').event;
    assert.equal(approvedContractEvent.turnId, harness.host.activeTurnIds.get('app-a'));
    assert.equal(harness.host.sessionTaskContractState().get('app-a').turnId, approvedContractEvent.turnId);
    assert.equal(
        harness.persisted.some(({ event }) => event.kind === 'goal-state'),
        false,
        'Xora must not manufacture Grok goal_updated state before the native Goal turn starts'
    );

    // Approval unlocks the very same native Plan loop immediately. Grok is
    // not required to publish current_mode_update before it edits, and Xora
    // must still preserve the Plan boundary before this explicit approval.
    harness.host.sidecarVersion = '0.2.102';
    harness.host.security = { agentPermissionMode: () => 'full-access' };
    harness.host.isWorkspaceTrusted = () => true;
    const approvedWrite = await harness.host.handlePermissionRequest({
        sessionId: 'acp-a',
        toolCall: {
            toolCallId: 'approved-plan-write',
            title: 'Implement approved Plan',
            kind: 'edit',
            locations: [{ path: '/fixture/src/example.ts', line: 1 }],
            rawInput: { path: '/fixture/src/example.ts' },
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name: 'search_replace',
                    kind: 'edit',
                    read_only: false
                }
            }
        },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    });
    assert.deepEqual(approvedWrite, {
        outcome: { outcome: 'selected', optionId: 'allow-once' }
    });

    planTurn.resolve({ stopReason: 'end_turn' });
    await waitFor(() => harness.requests.length === 2, 'approved Plan should hand off to one Goal turn');
    assert.equal(harness.host.pendingApprovedPlanState().has('app-a'), false);
    const activeGoalWrite = await harness.host.handlePermissionRequest({
        sessionId: 'acp-a',
        toolCall: {
            toolCallId: 'active-goal-write',
            title: 'Continue approved implementation',
            kind: 'edit',
            locations: [{ path: '/fixture/src/example.ts', line: 1 }],
            rawInput: { path: '/fixture/src/example.ts' },
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name: 'search_replace',
                    kind: 'edit',
                    read_only: false
                }
            }
        },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    });
    assert.deepEqual(activeGoalWrite, {
        outcome: { outcome: 'selected', optionId: 'allow-once' }
    }, 'the active frozen Goal contract keeps its implementation turn writable after one-shot handoff consumption');
    harness.host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'goal_updated',
            goal_id: 'goal-approved-plan',
            objective: approval.suggestedContract.objective,
            status: 'active',
            phase: 'executing',
            tokens_used: 100,
            elapsed_ms: 20,
            total_worker_rounds: 1,
            total_verify_rounds: 0,
            last_event: 'worker_started'
        }
    }, 'x.ai/session_notification');
    harness.host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'goal_updated',
            goal_id: 'goal-approved-plan',
            objective: approval.suggestedContract.objective,
            status: 'complete',
            phase: 'idle',
            tokens_used: 200,
            elapsed_ms: 40,
            total_worker_rounds: 1,
            total_verify_rounds: 1,
            last_classifier_verdict: 'achieved',
            last_event: 'goal_completed'
        }
    }, 'x.ai/session_notification');
    goalTurn.resolve({ stopReason: 'end_turn' });
    await sending;

    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[0].params.prompt[0].text, formatAgentWirePrompt('先规划一个可靠实现'));
    assert.match(harness.requests[1].params.prompt[0].text, /^\/goal /);
    assert.match(harness.requests[1].params.prompt[0].text, /先规划一个可靠实现/);
    assert.equal(
        harness.requests.filter(request => request.params.prompt?.[0]?.text?.startsWith('/goal ')).length,
        1
    );
    assert.equal(
        harness.delivered.filter(event => event.kind === 'text-delta' && event.role === 'user').length,
        1,
        'the internal Goal handoff must not create a second user bubble'
    );
    assert.deepEqual(
        harness.persisted
            .filter(({ event }) => event.kind === 'task-contract')
            .map(({ event }) => event.lifecycle),
        ['approved', 'goal-starting', 'goal-active', 'verified'],
        'only native goal_updated may advance the approved contract to verified'
    );
    assert.equal(approval.kind, 'plan-approval-request');
});

test('a Plan approval re-parked by session/load is actionable before hydration and starts exactly one Goal', async () => {
    let reverseOutcome;
    const harness = restoreHarness({
        history: [
            {
                kind: 'text-delta',
                sessionId: 'app-a',
                turnId: 'plan-turn-original',
                role: 'user',
                text: '恢复后继续完成原计划'
            },
            {
                kind: 'plan',
                sessionId: 'app-a',
                turnId: 'plan-turn-original',
                title: '原执行计划',
                providerRuntimeEpoch: 'epoch-a',
                entries: [
                    { id: 'restore-1', text: '恢复实现', status: 'in-progress' },
                    { id: 'restore-2', text: '运行验收', status: 'pending' }
                ]
            }
        ],
        onRequest: async ({ host, method }) => {
            assert.equal(method, 'session/load');
            const response = host.handlePlanApprovalRequest({
                sessionId: 'acp-a',
                toolCallId: 'restore-exit-plan',
                planContent: '1. 恢复实现\n2. 运行验收'
            });
            reverseOutcome = await response;
            return {
                modes: {
                    currentModeId: 'default',
                    availableModes: [
                        { id: 'default', name: 'Agent' },
                        { id: 'plan', name: 'Plan' }
                    ]
                }
            };
        }
    });
    await harness.host.getSessionHistory('app-a');
    const loading = harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
    await waitFor(
        () => harness.delivered.some(event => event.kind === 'plan-approval-request'),
        'replayed Plan approval should be delivered while session/load is still pending'
    );
    assert.equal(harness.host.loadedSessionIds.has('app-a'), false);
    const approval = harness.delivered.find(event => event.kind === 'plan-approval-request');
    await harness.host.respondPlanApproval({
        requestId: approval.requestId,
        outcome: 'approved',
        contract: {
            ...approval.suggestedContract,
            acceptanceCriteria: approvalContract().acceptanceCriteria
        }
    });
    const loaded = await loading;
    assert.deepEqual(reverseOutcome, { outcome: 'approved' });
    assert.equal(loaded.status, 'running');

    const goalRequests = () => harness.requests.filter(request =>
        request.method === 'session/prompt'
        && request.params.prompt?.[0]?.text?.startsWith('/goal '));
    assert.equal(goalRequests().length, 1);
    assert.equal(
        harness.delivered.some(event => event.kind === 'text-delta' && event.role === 'user'),
        false,
        'the restored internal handoff must not manufacture a user bubble'
    );

    for (const update of [
        { status: 'active', phase: 'executing' },
        { status: 'complete', phase: 'idle', last_classifier_verdict: 'achieved' }
    ]) {
        harness.host.acceptXaiSessionContext({
            sessionId: 'acp-a',
            update: {
                sessionUpdate: 'goal_updated',
                goal_id: 'goal-restored-plan',
                objective: approval.suggestedContract.objective,
                ...update
            }
        }, 'x.ai/session_notification');
    }
    harness.goalHandles[0].resolve({ stopReason: 'end_turn' });
    await waitFor(() => !harness.host.activePrompts.has('app-a'), 'restored Goal should finish');
    assert.equal(goalRequests().length, 1);
    assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'verified');
    assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).turnId, 'plan-turn-original');
    const restoredGoalTurnId = harness.history.filter(event => event.kind === 'goal-state').at(-1).turnId;
    assert.equal(restoredGoalTurnId, 'plan-turn-original');
    const verifiedHistory = await harness.host.getSessionHistory('app-a');
    const model = new AgentViewModel();
    model.showSessionHistory(harness.record(), verifiedHistory);
    const planEntry = model.transcript.find(entry => entry.kind === 'plan');
    assert.equal(planEntry.payload.outcome, 'completed');
    assert.equal(planEntry.payload.entries.every(entry => entry.status === 'completed'), true);
    assert.equal(model.pendingPlanApprovals.size, 0, 'replayed live approval must never become durable chrome');

    // The one-shot handoff is consumed only by the restored Plan. A later
    // ordinary message remains byte-for-byte ordinary and cannot delete or
    // relaunch the completed Goal contract.
    const ordinary = harness.host.sendPrompt({ sessionId: 'app-a', text: '普通后续消息' });
    await waitFor(
        () => harness.requests.filter(request => request.method === 'session/prompt').length === 2,
        'ordinary follow-up should start'
    );
    const ordinaryRequest = harness.requests.filter(request => request.method === 'session/prompt').at(-1);
    assert.equal(ordinaryRequest.params.prompt[0].text, formatAgentWirePrompt('普通后续消息'));
    harness.goalHandles[1].resolve({ stopReason: 'end_turn' });
    await ordinary;
    assert.equal(goalRequests().length, 1);
    assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'verified');
});

test('session/load performs zero ACP mutation while a foreign durable prompt claim is running', async () => {
    const harness = restoreHarness({ record: { status: 'running' } });
    harness.host.promptClaimOwnership = () => 'foreign';

    await assert.rejects(
        harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] }),
        /still running in another Xora Code process/
    );
    assert.deepEqual(harness.requests, [], 'foreign ownership must be checked before session/load or set_model');
    assert.equal(harness.record().status, 'running');
});

test('a restored Goal claims before ACP and releases ownership when runtime authority changes', async () => {
    const harness = restoreHarness({ record: { status: 'idle' } });
    const timeline = [];
    let liveToken;
    harness.host.sessions.claimPrompt = (id, validate) => {
        assert.equal(id, 'app-a');
        validate(harness.record());
        liveToken = 'restored-goal-token';
        Object.assign(harness.record(), { status: 'running' });
        timeline.push('claim');
        return { record: harness.record(), token: liveToken };
    };
    harness.host.sessions.finishPrompt = (id, token, status) => {
        assert.equal(id, 'app-a');
        assert.equal(token, liveToken);
        Object.assign(harness.record(), { status });
        liveToken = undefined;
        timeline.push(`finish:${status}`);
        return harness.record();
    };
    const startRequest = harness.host.acp.startRequest.bind(harness.host.acp);
    harness.host.acp.startRequest = (...args) => {
        timeline.push('acp');
        return startRequest(...args);
    };
    harness.host.loadedSessionIds.add('app-a');
    const contract = approvalContract();
    harness.host.pendingApprovedPlanState().set('app-a', contract);
    harness.host.sessionTaskContractState().set('app-a', taskContract({
        lifecycle: 'approved',
        objective: contract.objective
    }));

    const running = harness.host.startRestoredApprovedPlanGoal('app-a');
    assert.equal(running.status, 'running');
    assert.deepEqual(timeline.slice(0, 2), ['claim', 'acp']);
    harness.host.runtimeGeneration += 1;
    harness.goalHandles[0].resolve({ stopReason: 'end_turn' });
    await waitFor(() => !harness.host.activePrompts.has('app-a'), 'authority change should settle Goal observer');
    assert.equal(liveToken, undefined);
    assert.equal(harness.record().status, 'failed');
    assert.equal(harness.host.promptClaimTokenState().has('app-a'), false);
    assert.equal(timeline.filter(item => item.startsWith('finish:')).length, 1);
});

test('cancelled, failed and stale re-parked approvals never launch Goal or poison the next ordinary prompt', async t => {
    await t.test('cancelled by the user', async () => {
        let reverseOutcome;
        const harness = restoreHarness({
            history: [taskContract({ lifecycle: 'interrupted' })],
            onRequest: async ({ host }) => {
                reverseOutcome = await host.handlePlanApprovalRequest({
                    sessionId: 'acp-a',
                    toolCallId: 'cancel-exit-plan',
                    planContent: '不会执行的计划'
                });
                return { modes: { currentModeId: 'default', availableModes: [] } };
            }
        });
        await harness.host.getSessionHistory('app-a');
        const loading = harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
        await waitFor(() => harness.delivered.some(event => event.kind === 'plan-approval-request'), 'approval should park');
        const approval = harness.delivered.find(event => event.kind === 'plan-approval-request');
        await harness.host.respondPlanApproval({ requestId: approval.requestId, outcome: 'cancelled', feedback: '先不执行' });
        await loading;
        assert.deepEqual(reverseOutcome, { outcome: 'cancelled', feedback: '先不执行' });
        assert.equal(harness.requests.some(request => request.method === 'session/prompt'), false);
        assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'interrupted');

        const ordinary = harness.host.sendPrompt({ sessionId: 'app-a', text: '保持普通发送' });
        await waitFor(() => harness.requests.some(request => request.method === 'session/prompt'), 'ordinary prompt should start');
        const request = harness.requests.find(item => item.method === 'session/prompt');
        assert.equal(request.params.prompt[0].text, formatAgentWirePrompt('保持普通发送'));
        harness.goalHandles[0].resolve({ stopReason: 'end_turn' });
        await ordinary;
        assert.equal(request.params.prompt[0].text.startsWith('/goal '), false);
    });

    await t.test('capability lost during restore interrupts an approved Plan before Goal starts', async () => {
        let reverseOutcome;
        const harness = restoreHarness({
            history: [{
                kind: 'plan',
                sessionId: 'app-a',
                turnId: 'capability-plan-turn',
                title: '能力变化计划',
                providerRuntimeEpoch: 'epoch-a',
                entries: [{ id: 'one', text: '执行目标', status: 'in-progress' }]
            }],
            onRequest: async ({ host }) => {
                reverseOutcome = await host.handlePlanApprovalRequest({
                    sessionId: 'acp-a',
                    toolCallId: 'capability-exit-plan',
                    planContent: '1. 执行目标'
                });
                host.acceptSessionUpdate({
                    sessionId: 'acp-a',
                    update: {
                        sessionUpdate: 'available_commands_update',
                        availableCommands: [],
                        _meta: { tools: [] }
                    }
                });
                return {
                    modes: {
                        currentModeId: 'default',
                        availableModes: [{ id: 'default', name: 'Agent' }]
                    }
                };
            }
        });
        await harness.host.getSessionHistory('app-a');
        const loading = harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
        await waitFor(() => harness.delivered.some(event => event.kind === 'plan-approval-request'), 'approval should park');
        const approval = harness.delivered.find(event => event.kind === 'plan-approval-request');
        await harness.host.respondPlanApproval({
            requestId: approval.requestId,
            outcome: 'approved',
            contract: {
                ...approval.suggestedContract,
                acceptanceCriteria: ['确认能力变化时不启动 Goal']
            }
        });
        const loaded = await loading;
        assert.deepEqual(reverseOutcome, { outcome: 'approved' });
        assert.notEqual(loaded.status, 'running');
        assert.equal(harness.requests.some(request => request.method === 'session/prompt'), false);
        assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'interrupted');
        const error = harness.delivered.find(event => event.kind === 'error' && event.code === 'GOAL_CAPABILITY_CHANGED');
        assert.equal(error?.recoverable, true);
    });

    await t.test('runtime failure abandons the live approval', async () => {
        let reverseOutcome;
        const harness = restoreHarness({
            history: [taskContract({ lifecycle: 'interrupted' })],
            onRequest: async ({ host }) => {
                reverseOutcome = await host.handlePlanApprovalRequest({
                    sessionId: 'acp-a',
                    toolCallId: 'failed-exit-plan',
                    planContent: '运行时会在审批期间失败'
                });
                return { modes: { currentModeId: 'default', availableModes: [] } };
            }
        });
        await harness.host.getSessionHistory('app-a');
        const loading = harness.host.loadSessionUncoalesced('app-a', () => undefined, { mcpServers: [] });
        await waitFor(() => harness.delivered.some(event => event.kind === 'plan-approval-request'), 'approval should park');
        harness.host.clearGoalRuntimeState('error');
        await loading;
        assert.deepEqual(reverseOutcome, { outcome: 'abandoned' });
        assert.equal(harness.requests.some(request => request.method === 'session/prompt'), false);
        assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'interrupted');
    });

    for (const staleAuthority of ['runtime-generation', 'provider-epoch']) {
        await t.test(staleAuthority, async () => {
            const harness = restoreHarness({ history: [taskContract({ lifecycle: 'interrupted' })] });
            await harness.host.getSessionHistory('app-a');
            harness.host.beginSessionRestore('app-a');
            const response = harness.host.handlePlanApprovalRequest({
                sessionId: 'acp-a',
                toolCallId: `stale-${staleAuthority}`,
                planContent: '过期审批'
            });
            await waitFor(() => harness.delivered.some(event => event.kind === 'plan-approval-request'), 'approval should park');
            const approval = harness.delivered.find(event => event.kind === 'plan-approval-request');
            if (staleAuthority === 'runtime-generation') harness.host.runtimeGeneration += 1;
            else harness.host.runtimeProviderEpoch = 'epoch-b';
            await assert.rejects(harness.host.respondPlanApproval({
                requestId: approval.requestId,
                outcome: 'approved',
                contract: approvalContract()
            }), /runtime changed/);
            assert.deepEqual(await response, { outcome: 'abandoned' });
            assert.equal(harness.host.pendingApprovedPlanState().has('app-a'), false);
            assert.equal(harness.requests.some(request => request.method === 'session/prompt'), false);
            assert.equal(harness.history.filter(event => event.kind === 'task-contract').at(-1).lifecycle, 'interrupted');
            harness.host.endSessionRestore('app-a');
        });
    }
});

test('approved Plan cancellation and error never trigger an implicit Goal turn', async t => {
    await t.test('cancelled Plan turn', async () => {
        const planTurn = deferred();
        const harness = hostHarness([planTurn]);
        const sending = harness.host.sendPrompt({ sessionId: 'app-a', text: '规划后执行' });
        await waitFor(() => harness.requests.length === 1, 'Plan turn should start');
        await approveCurrentPlan(harness);
        planTurn.resolve({ stopReason: 'cancelled' });
        await sending;
        assert.equal(harness.requests.length, 1);
    });

    await t.test('failed Plan turn', async () => {
        const planTurn = deferred();
        const harness = hostHarness([planTurn]);
        const sending = harness.host.sendPrompt({ sessionId: 'app-a', text: '规划后执行' });
        await waitFor(() => harness.requests.length === 1, 'Plan turn should start');
        await approveCurrentPlan(harness);
        planTurn.reject(new Error('Plan failed'));
        const receipt = await sending;
        assert.equal(receipt.admitted, true);
        assert.equal(receipt.outcome, 'failed');
        assert.equal(harness.requests.length, 1);
    });
});

test('Chinese prompts add a hidden locale hint while the UI text stays exact and explicit continuous mode uses native /goal', async () => {
    const normal = hostHarness([{ promise: Promise.resolve({ stopReason: 'end_turn' }) }]);
    await normal.host.sendPrompt({ sessionId: 'app-a', text: '普通小任务' });
    assert.equal(normal.requests.length, 1);
    assert.equal(normal.requests[0].params.prompt[0].text, formatAgentWirePrompt('普通小任务'));
    assert.match(normal.requests[0].params.prompt[0].text, /请使用中文展示思考过程和最终回复/);
    assert.equal(normal.delivered.find(event => event.kind === 'text-delta' && event.role === 'user').text, '普通小任务');

    assert.equal(formatAgentWirePrompt('Refactor this module'), 'Refactor this module');
    assert.equal(formatAgentWirePrompt('请用英文回答这个问题'), '请用英文回答这个问题');

    const continuous = hostHarness([{ promise: Promise.resolve({ stopReason: 'end_turn' }) }]);
    await continuous.host.sendPrompt({
        sessionId: 'app-a',
        text: '持续完成这个目标',
        executionMode: 'continuous'
    });
    assert.equal(continuous.requests.length, 1);
    assert.equal(continuous.requests[0].params.prompt[0].text, formatContinuousGoalPrompt('持续完成这个目标'));
    assert.match(continuous.requests[0].params.prompt[0].text, /简单、只读、总结或一次即可验证的目标/);
    assert.match(continuous.requests[0].params.prompt[0].text, /不要为了流程刻意增加轮次、启动子 Agent 或重复验收/);
    assert.equal(
        continuous.delivered.find(event => event.kind === 'text-delta' && event.role === 'user').text,
        '持续完成这个目标',
        'the product UI must retain only the original user text'
    );
});

test('native Goal completion releases a continuous turn whose outer prompt never resolves', async () => {
    const stuck = deferred();
    let cancelled = 0;
    stuck.cancel = async () => {
        cancelled += 1;
        stuck.reject(Object.assign(new Error('cancelled after Goal completion'), { kind: 'cancelled' }));
    };
    const harness = hostHarness([stuck]);
    const sending = harness.host.sendPrompt({
        sessionId: 'app-a',
        text: '完成一个简单目标',
        executionMode: 'continuous'
    });
    await waitFor(() => harness.requests.length === 1, 'continuous Goal should start');
    for (const update of [
        { status: 'active', phase: 'executing' },
        { status: 'complete', phase: 'idle', last_classifier_verdict: 'achieved' }
    ]) {
        harness.host.acceptXaiSessionContext({
            sessionId: 'acp-a',
            update: {
                sessionUpdate: 'goal_updated',
                goal_id: 'goal-stuck-prompt',
                objective: '完成一个简单目标',
                ...update
            }
        }, 'x.ai/session_notification');
    }
    await sending;
    assert.equal(cancelled, 1, 'Xora should close only the completed outer wire request after the final-text grace period');
    assert.equal(harness.record().status, 'completed');
    assert.equal(harness.host.activePrompts.size, 0);
    assert.equal(harness.host.goalCompletionSignals.size, 0);
    assert.equal(harness.delivered.filter(event => event.kind === 'error').length, 0);
    assert.equal(harness.delivered.filter(event => event.kind === 'turn-completed').at(-1).stopReason, 'end_turn');
});

test('restored interrupted Plan contracts settle old cards instead of returning to proposal state', async t => {
    for (const [stopReason, expectedOutcome, expectedStepStatus] of [
        ['cancelled', 'cancelled', 'cancelled'],
        ['error', 'failed', 'failed']
    ]) {
        await t.test(stopReason, () => {
            const model = new AgentViewModel();
            const planSession = session({
                status: stopReason === 'cancelled' ? 'cancelled' : 'failed',
                currentModeId: 'plan'
            });
            model.showSessionHistory(planSession, [
                {
                    kind: 'text-delta',
                    sessionId: 'app-a',
                    turnId: 'old-plan-turn',
                    role: 'user',
                    text: '先规划再执行'
                },
                {
                    kind: 'plan',
                    sessionId: 'app-a',
                    turnId: 'old-plan-turn',
                    title: '执行计划',
                    providerRuntimeEpoch: 'epoch-a',
                    entries: [
                        { id: 'one', text: '第一步', status: 'in-progress' },
                        { id: 'two', text: '第二步', status: 'pending' }
                    ]
                },
                taskContract({
                    turnId: 'old-plan-turn',
                    lifecycle: 'interrupted'
                }),
                {
                    kind: 'turn-completed',
                    sessionId: 'app-a',
                    turnId: 'restored-goal-turn',
                    stopReason,
                    elapsedMs: 100
                }
            ]);
            const plan = model.transcript.find(entry => entry.kind === 'plan').payload;
            assert.equal(plan.outcome, expectedOutcome);
            assert.equal(plan.entries.every(entry => entry.status === expectedStepStatus), true);
        });
    }
});

test('history replay settles a terminal task contract even when turn-completed was never persisted', async t => {
    const history = lifecycle => [
        {
            kind: 'text-delta',
            sessionId: 'app-a',
            turnId: 'durable-plan-turn',
            role: 'user',
            text: '完成这个计划'
        },
        {
            kind: 'plan',
            sessionId: 'app-a',
            turnId: 'durable-plan-turn',
            title: '执行计划',
            providerRuntimeEpoch: 'epoch-a',
            entries: [
                { id: 'one', text: '第一步', status: 'in-progress' },
                { id: 'two', text: '第二步', status: 'pending' }
            ]
        },
        taskContract({ turnId: 'durable-plan-turn', lifecycle })
    ];

    await t.test('showSessionHistory verifies the original Plan', () => {
        const model = new AgentViewModel();
        model.showSessionHistory(session({ status: 'completed' }), history('verified'));
        const plan = model.transcript.find(entry => entry.kind === 'plan').payload;
        assert.equal(plan.outcome, 'completed');
        assert.equal(plan.entries.every(entry => entry.status === 'completed'), true);
    });

    await t.test('loadHistory interrupts the original Plan', () => {
        const model = new AgentViewModel();
        model.snapshot.sessions = [session({ status: 'cancelled' })];
        model.snapshot.activeSessionId = 'app-a';
        model.loadHistory(history('interrupted'));
        const plan = model.transcript.find(entry => entry.kind === 'plan').payload;
        assert.equal(plan.outcome, 'cancelled');
        assert.equal(plan.entries.every(entry => entry.status === 'cancelled'), true);
    });

    await t.test('approved and active contracts remain live', () => {
        for (const lifecycle of ['approved', 'goal-starting', 'goal-active']) {
            const model = new AgentViewModel();
            model.showSessionHistory(session({ status: 'running' }), history(lifecycle));
            const plan = model.transcript.find(entry => entry.kind === 'plan').payload;
            assert.equal(plan.outcome, undefined, lifecycle);
            assert.deepEqual(plan.entries.map(entry => entry.status), ['in-progress', 'pending'], lifecycle);
        }
    });
});

test('shadow eligibility is persisted locally but ignored by the conversation model', () => {
    const shadow = buildSupervisionShadowEvent('app-a', 'turn-a', {
        sawPlan: true,
        openPlanCount: 2,
        failedToolIds: new Set(['tool-failed']),
        testEvidenceIds: new Set()
    });
    assert.deepEqual(shadow.reasons, ['open-plan', 'tool-failure', 'missing-test-evidence']);
    assert.equal(shadow.eligible, true);

    const harness = hostHarness();
    harness.host.emit(shadow);
    assert.equal(harness.persisted.at(-1).event.kind, 'supervision-shadow');

    const model = new AgentViewModel();
    model.showSessionHistory(session(), [
        { kind: 'text-delta', sessionId: 'app-a', role: 'user', text: '检查这个任务' },
        shadow,
        { kind: 'text-delta', sessionId: 'app-a', role: 'assistant', text: '已检查' }
    ]);
    assert.deepEqual(model.transcript.map(entry => entry.kind), ['user', 'assistant']);
    assert.equal(model.transcript.some(entry => entry.payload?.kind === 'supervision-shadow'), false);
});
