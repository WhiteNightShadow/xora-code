const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const { AgentViewModel } = require('../lib/browser/agent-view-model');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

function session(appSessionId, status = 'idle', overrides = {}) {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: `Session ${appSessionId}`,
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
        status,
        ...overrides
    };
}

function runtimeSnapshot(workspaceRoot, sessions, activeSessionId) {
    return {
        phase: 'ready',
        workspaceRoot,
        workspaceAttached: true,
        workspaceTrusted: true,
        providerId: 'grok-subscription',
        grokSubscriptionAuthStatus: 'authenticated',
        models: [{ id: 'grok', name: 'Grok' }],
        selectedModel: 'grok',
        sessions,
        activeSessionId,
        permissionMode: 'request-approval'
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function hostHarness() {
    // Bypass the real Electron constructor. These tests exercise only the
    // ordering contract of loadSession and never touch disk or launch Grok.
    const host = Object.create(GrokAgentHostService.prototype);
    const records = new Map([
        ['a', session('a')],
        ['b', session('b')]
    ]);
    const requests = [];

    host.sessions = {
        get: id => records.get(id),
        update: (id, patch) => {
            const updated = { ...records.get(id), ...patch };
            records.set(id, updated);
            return updated;
        }
    };
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.restoringSessionCounts = new Map();
    host.sessionLoadGeneration = 0;
    host.runtimeGeneration = 1;
    host.acp = {
        request: (method, params) => {
            const completion = deferred();
            requests.push({ method, params, completion });
            return completion.promise;
        }
    };
    host.workspaceRoot = '/fixture';
    host.providerId = 'grok-subscription';
    host.phase = 'ready';
    host.sidecarVersion = '0.2.102';
    host.currentSecrets = [];
    host.acceptModelState = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;

    return { host, requests };
}

function widgetClass() {
    require.extensions['.css'] = () => undefined;
    for (const name of ['Element', 'HTMLElement', 'Event', 'MouseEvent', 'DragEvent', 'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'Node', 'File', 'Blob']) {
        if (!global[name]) global[name] = class {};
    }
    global.Element.prototype.matches = () => false;
    global.HTMLElement.prototype = Object.create(global.Element.prototype);
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const element = () => ({
        style: {},
        classList: { add: () => undefined, remove: () => undefined, contains: () => false },
        setAttribute: () => undefined,
        appendChild: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        ownerDocument: undefined
    });
    global.document = {
        createElement: element,
        body: element(),
        documentElement: element(),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        queryCommandSupported: () => false
    };
    global.window = {
        document: global.document,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        navigator: { userAgent: '', platform: '' },
        localStorage: storage,
        sessionStorage: storage,
        location: { search: '', hostname: 'localhost' },
        getComputedStyle: () => ({})
    };
    global.navigator = global.window.navigator;
    global.location = global.window.location;
    global.requestAnimationFrame = callback => {
        callback(performance.now());
        return 1;
    };
    const { FrontendApplicationConfigProvider } = require('@theia/core/lib/browser/frontend-application-config-provider');
    try {
        FrontendApplicationConfigProvider.set({ applicationName: 'Xora Code test' });
    } catch {
        // Another browser-oriented test may already have configured the singleton.
    }
    return require('../lib/browser/agent-widget').XoraAgentWidget;
}

test('an inactive session status update does not steal the active selection', () => {
    const model = new AgentViewModel();
    model.snapshot.sessions = [session('a', 'running'), session('b', 'idle')];
    model.setSession(session('b', 'idle'));
    model.loadHistory([
        { kind: 'text-delta', sessionId: 'b', role: 'assistant', text: 'History B' }
    ]);

    model.accept({ kind: 'session', session: session('a', 'completed') });

    assert.equal(model.snapshot.activeSessionId, 'b');
    assert.equal(model.snapshot.sessions.find(item => item.appSessionId === 'a').status, 'completed');
    assert.deepEqual(model.transcript.map(entry => entry.text), ['History B']);
});

test('late events from an inactive session cannot contaminate the visible transcript', () => {
    const model = new AgentViewModel();
    model.snapshot.sessions = [session('a', 'completed'), session('b', 'idle')];
    model.setSession(session('b', 'idle'));
    model.loadHistory([
        { kind: 'text-delta', sessionId: 'b', role: 'assistant', text: 'History B' }
    ]);

    model.accept({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'late text A' });
    model.accept({
        kind: 'plan',
        sessionId: 'a',
        entries: [{ id: 'late-plan', text: 'late plan A', status: 'completed' }]
    });
    model.accept({
        kind: 'tool-call',
        sessionId: 'a',
        toolCallId: 'late-tool-a',
        title: 'late tool A',
        toolName: 'fixture/tool',
        status: 'completed'
    });
    model.accept({
        kind: 'diff',
        sessionId: 'a',
        diffId: 'late-diff-a',
        path: 'late-a.ts',
        diff: '+late A'
    });
    model.accept({
        kind: 'permission-request',
        sessionId: 'a',
        requestId: 'late-permission-a',
        title: 'late permission A',
        options: ['reject']
    });
    model.accept({
        kind: 'error',
        sessionId: 'a',
        code: 'LATE_A',
        message: 'late error A',
        recoverable: true
    });
    model.accept({ kind: 'text-delta', sessionId: 'b', role: 'assistant', text: ' still B' });

    assert.equal(model.snapshot.activeSessionId, 'b');
    assert.equal(model.transcript.length, 1);
    assert.equal(model.transcript[0].text, 'History B still B');
});

test('the first active snapshot discards events raced from another session', () => {
    const model = new AgentViewModel();
    model.accept({
        kind: 'tool-call',
        sessionId: 'a',
        toolCallId: 'shared-tool',
        title: 'read A',
        toolName: 'read_file',
        status: 'completed'
    });
    assert.equal(model.transcript.length, 1);

    model.accept({
        kind: 'snapshot',
        snapshot: {
            phase: 'ready',
            workspaceRoot: '/fixture',
            workspaceTrusted: true,
            providerId: 'grok-subscription',
            models: [],
            sessions: [session('a'), session('b')],
            activeSessionId: 'b',
            permissionMode: 'request-approval'
        }
    });
    assert.equal(model.transcript.length, 0);
});

test('workspace activation keeps history but pins a clean page across A-B-A and same-root reopen', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const model = new AgentViewModel();
    const sessionA = session('a', 'completed', { workspaceRoot: '/workspace-a' });
    const sessionB = session('b', 'completed', { workspaceRoot: '/workspace-b' });
    let prewarms = 0;

    model.accept({ kind: 'snapshot', snapshot: runtimeSnapshot('/workspace-a', [sessionA, sessionB], 'a') });
    model.setSession(sessionA);
    model.loadHistory([
        { kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'history A' }
    ]);
    widget.model = model;
    widget.roots = ['/workspace-a'];
    widget.openPopover = 'history';
    widget.agentPaneView = 'activity';
    widget.activityFilter = 'tools';
    widget.invalidateAgentContext = () => undefined;
    widget.requestRuntimePrewarm = () => { prewarms += 1; };
    widget.update = () => undefined;

    const activate = (root, staleActiveSessionId) => {
        widget.activateWorkspace([root]);
        model.accept({
            kind: 'snapshot',
            snapshot: runtimeSnapshot(root, [sessionA, sessionB], staleActiveSessionId)
        });
        assert.equal(model.snapshot.activeSessionId, undefined);
        assert.equal(model.transcript.length, 0);
        assert.deepEqual(model.snapshot.sessions.map(candidate => candidate.appSessionId), ['a', 'b']);
    };

    activate('/workspace-b', 'b');
    activate('/workspace-a', 'a');
    model.showSessionHistory(sessionA, [
        { kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'manually restored A' }
    ]);
    assert.equal(model.snapshot.activeSessionId, 'a');
    assert.deepEqual(model.transcript.map(entry => entry.text), ['manually restored A']);
    // A workspace event is an activation boundary even when Theia reports the
    // same canonical root again.
    activate('/workspace-a', 'a');

    assert.equal(prewarms, 3);
    assert.equal(widget.openPopover, undefined);
    assert.equal(widget.agentPaneView, 'conversation');
});

test('late session and snapshot events cannot steal a workspace fresh page', () => {
    const model = new AgentViewModel();
    const previous = session('a', 'idle', { workspaceRoot: '/fixture' });
    model.accept({ kind: 'snapshot', snapshot: runtimeSnapshot('/fixture', [previous], 'a') });
    model.setSession(previous);
    model.loadHistory([
        { kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'old response' }
    ]);

    model.startNewSession();
    // These are the two observable effects of a session/load that finished
    // after the workspace activation boundary.
    model.accept({ kind: 'session', session: { ...previous, status: 'idle' } });
    model.accept({ kind: 'snapshot', snapshot: runtimeSnapshot('/fixture', [previous], 'a') });

    assert.equal(model.snapshot.activeSessionId, undefined);
    assert.equal(model.transcript.length, 0);
    assert.equal(model.snapshot.sessions[0].appSessionId, 'a', 'history remains manually recoverable');
});

test('tool updates are keyed by session as well as ACP call id', () => {
    const model = new AgentViewModel();
    model.accept({
        kind: 'tool-call', sessionId: 'a', toolCallId: 'shared-tool',
        title: 'read A', toolName: 'read_file', status: 'completed'
    });
    model.accept({
        kind: 'tool-call', sessionId: 'b', toolCallId: 'shared-tool',
        title: 'read B', toolName: 'read_file', status: 'completed'
    });

    assert.equal(model.transcript.length, 2);
    assert.deepEqual(model.transcript.map(entry => entry.payload.sessionId), ['a', 'b']);
});

test('the latest A-B-A activation wins even when an older load completes last', async () => {
    const { host, requests } = hostHarness();

    const firstA = host.loadSession('a');
    const middleB = host.loadSession('b');
    const latestA = host.loadSession('a');

    await Promise.resolve();
    if (requests.length === 3) {
        // Concurrent implementations must ignore the stale B activation when
        // its sidecar response arrives after the final A request.
        requests[0].completion.resolve({});
        await Promise.resolve();
        requests[2].completion.resolve({});
        await Promise.resolve();
        requests[1].completion.resolve({});
    } else {
        // A serialized implementation is also valid. Resolve each request as
        // it is issued so all three activation intents can finish.
        for (let index = 0; index < 3; index += 1) {
            while (!requests[index]) await new Promise(resolve => setImmediate(resolve));
            requests[index].completion.resolve({});
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    await Promise.allSettled([firstA, middleB, latestA]);

    assert.equal(host.activeSessionId, 'a');
});

test('ACP replay updates are ignored while a session is being restored', () => {
    const { host } = hostHarness();
    const emitted = [];
    host.emit = event => emitted.push(event);
    host.acpSessionLookup.set('acp-a', 'a');

    host.beginSessionRestore('a');
    host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'historic replay' } }
    });
    host.endSessionRestore('a');

    assert.deepEqual(emitted, []);

    host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live output' } }
    });
    assert.deepEqual(emitted, [
        { kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'live output' }
    ]);
});

test('Grok canonical tool metadata survives ACP normalization as safe activity labels', () => {
    const { host } = hostHarness();
    const emitted = [];
    host.emit = event => emitted.push(event);
    host.acpSessionLookup.set('acp-a', 'a');

    const tool = (toolCallId, name, kind, namespace, rawInput, extra = {}) => host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: name,
            kind: kind === 'web_search' ? 'search' : 'other',
            status: 'pending',
            rawInput,
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name,
                    kind,
                    namespace,
                    label: name,
                    read_only: kind === 'web_search',
                    input: rawInput
                }
            },
            ...extra
        }
    });

    tool('web-1', 'web_search', 'web_search', 'grok_build', { query: 'Agent activity UI' });
    tool('skill-1', 'skill', 'skill', 'grok_build', { skill: 'ui-review' });
    tool('mcp-1', 'github__create_issue', 'other', 'mcp', { title: 'Issue' });
    host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'plugin-1',
            title: 'plugin_update',
            kind: 'other',
            status: 'pending',
            rawInput: { plugin_name: 'team-tools' }
        }
    });
    tool('mcp-cli-1', 'run_terminal_cmd', 'execute', 'grok_build', {
        command: 'grok --no-auto-update mcp doctor --json',
        description: '检查 MCP 服务'
    });
    tool('plugin-native-1', 'quality-check', 'plugin', 'plugin', { operation: 'inspect' });
    tool('create-1', 'create_file', 'create', 'grok_build', { path: 'src/new-agent.ts' });
    tool('edit-metadata-1', 'search_replace', 'edit', 'grok_build', { path: 'src/existing.ts' }, {
        _meta: {
            'x.ai/tool': {
                version: 1,
                name: 'search_replace',
                kind: 'edit',
                namespace: 'grok_build',
                label: 'Edit',
                read_only: true,
                input: { path: 'src/existing.ts' }
            }
        }
    });

    assert.equal(emitted[0].toolName, 'web_search');
    assert.equal(emitted[0].toolKind, 'web_search');
    assert.deepEqual(emitted[0].presentation, {
        action: 'web-search', source: 'builtin', targetLabel: 'Agent activity UI',
        sourceLabel: undefined, operationLabel: undefined, readOnly: true
    });
    assert.equal(emitted[1].presentation.source, 'skill');
    assert.equal(emitted[1].presentation.sourceLabel, 'ui-review');
    assert.equal(emitted[2].presentation.source, 'mcp');
    assert.equal(emitted[2].presentation.sourceLabel, 'github');
    assert.equal(emitted[2].presentation.operationLabel, 'create_issue');
    assert.equal(emitted[3].presentation.source, 'plugin');
    assert.equal(emitted[3].presentation.sourceLabel, 'team-tools');
    assert.equal(emitted[4].presentation.source, 'mcp');
    assert.equal(emitted[4].presentation.action, 'terminal');
    assert.equal(emitted[4].presentation.operationLabel, '管理配置');
    assert.equal(emitted[5].presentation.source, 'plugin');
    assert.equal(emitted[6].presentation.action, 'file-create');
    assert.equal(emitted[6].presentation.targetLabel, 'new-agent.ts');
    assert.equal(emitted[7].presentation.action, 'file-write');
    assert.equal(emitted[7].presentation.readOnly, false);
});

test('tool labels redact exact secrets before safe truncation', () => {
    const { host } = hostHarness();
    const emitted = [];
    const secret = `relay-secret-${'x'.repeat(180)}`;
    host.currentSecrets = [secret];
    host.emit = event => emitted.push(event);
    host.acpSessionLookup.set('acp-a', 'a');

    host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'web-secret-1',
            title: 'web_search',
            kind: 'search',
            status: 'completed',
            rawInput: { query: `design ${secret}` },
            content: [{ type: 'content', content: { type: 'text', text: `${secret} result` } }],
            _meta: {
                'x.ai/tool': {
                    version: 1,
                    name: 'web_search',
                    kind: 'web_search',
                    namespace: 'grok_build',
                    label: secret,
                    read_only: true,
                    input: { query: `design ${secret}` }
                }
            }
        }
    });

    const serialized = JSON.stringify(emitted);
    assert.doesNotMatch(serialized, /relay-secret-/);
    assert.match(serialized, /REDACTED/);
});

test('oversized tool input is omitted before renderer IPC and history persistence', () => {
    const { host } = hostHarness();
    const emitted = [];
    host.emit = event => emitted.push(event);
    host.acpSessionLookup.set('acp-a', 'a');

    host.acceptSessionUpdate({
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'large-input-1',
            title: 'apply_patch',
            kind: 'edit',
            status: 'completed',
            rawInput: { patch: 'line '.repeat(20_000) }
        }
    });

    assert.equal(emitted[0].input.truncated, true);
    assert.match(emitted[0].input.notice, /已.*省略/);
    assert.ok(JSON.stringify(emitted[0].input).length < 500);
});

test('repeated running and completed tool diffs create one persisted event and revert handle', () => {
    const { host } = hostHarness();
    const emitted = [];
    let beforeImages = 0;
    host.workspaceRoot = '/fixture';
    host.emittedDiffKeys = new Set();
    host.revertableDiffs = new Map();
    host.safeWorkspaceFile = candidate => path.normalize(candidate);
    host.sessions.saveBeforeImage = (_sessionId, _changedPath, oldText) => {
        beforeImages += 1;
        return { path: `/history/before-${beforeImages}`, hash: require('node:crypto').createHash('sha256').update(oldText).digest('hex') };
    };
    host.emit = event => emitted.push(event);

    const content = [{
        type: 'diff',
        path: 'docs/project-overview.md',
        oldText: 'before\n',
        newText: 'after\n'
    }];
    host.acceptToolUpdate('session-a', {
        toolCallId: 'edit-1', title: 'Edit file', status: 'running', content
    }, 'tool_call');
    host.acceptToolUpdate('session-a', {
        toolCallId: 'edit-1', title: 'Edit file', status: 'completed', content
    }, 'tool_call_update');

    assert.equal(emitted.filter(event => event.kind === 'diff').length, 1);
    assert.equal(beforeImages, 1);
    assert.equal(host.revertableDiffs.size, 1);
    assert.equal(host.emittedDiffKeys.size, 1);
});

test('the backend diff dedupe guard remains bounded', () => {
    const { host } = hostHarness();
    host.emittedDiffKeys = new Set();

    for (let index = 0; index < 2200; index += 1) {
        host.rememberEmittedDiff(`diff-${index}`);
    }

    assert.equal(host.emittedDiffKeys.size, 2048);
    assert.equal(host.emittedDiffKeys.has('diff-0'), false);
    assert.equal(host.emittedDiffKeys.has('diff-2199'), true);
});

test('reopening the already active hydrated session does not call ACP again', async () => {
    const { host, requests } = hostHarness();
    host.activeSessionId = 'a';
    host.loadedSessionIds.add('a');

    const loaded = await host.loadSession('a');

    assert.equal(loaded.appSessionId, 'a');
    assert.equal(requests.length, 0);
});

test('Provider switching waits for lifecycle work and rechecks an active turn', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const startGate = deferred();
    let selected = false;
    host.lifecycleTail = Promise.resolve();
    host.providers = {
        get: id => ({ id, name: id, kind: id === 'grok-subscription' ? 'grok-subscription' : 'xai-api-key' }),
        selectProvider: () => { selected = true; }
    };
    host.activePrompts = new Map();
    host.supervisor = { running: false };
    host.acp = undefined;
    host.managementChild = undefined;
    host.phase = 'stopped';
    host.sessionLoadGeneration = 0;
    host.providerId = 'grok-subscription';
    host.models = [];
    host.emitSnapshot = () => undefined;
    host.snapshot = () => ({ providerId: host.providerId });
    host.startRuntimeLocked = async () => {
        await startGate.promise;
        return host.snapshot();
    };

    const starting = host.startRuntime({ workspaceRoot: '/fixture', providerId: 'grok-subscription' });
    await new Promise(resolve => setImmediate(resolve));
    const switching = host.selectProvider('xai-api-key');
    host.activePrompts.set('turn', {});
    startGate.resolve();

    await starting;
    await assert.rejects(switching, /Cancel or finish the current task/);
    assert.equal(selected, false);
    assert.equal(host.providerId, 'grok-subscription');
});

test('a new session can load ACP models before its first prompt', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    widget.modelOptionsLoading = false;
    widget.sessionLoading = false;
    widget.submission = undefined;
    widget.agentContextGeneration = 0;
    widget.roots = ['/fixture'];
    widget.providers = [{ id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.model = {
        snapshot: {
            phase: 'stopped',
            workspaceRoot: '/fixture',
            workspaceAttached: true,
            workspaceTrusted: true,
            providerId: 'grok-subscription',
            models: [],
            sessions: [],
            permissionMode: 'request-approval'
        },
        refresh: async () => {
            timeline.push('refresh');
            widget.model.snapshot.phase = 'ready';
            widget.model.snapshot.models = [{ id: 'grok-fixture', name: 'Grok Fixture' }];
            widget.model.snapshot.selectedModel = 'grok-fixture';
        }
    };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        startRuntime: async () => {
            timeline.push('start');
            return { ...widget.model.snapshot, phase: 'ready' };
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;

    await widget.loadModelOptions();
    await widget.selectModel(undefined, 'grok-fixture');

    assert.deepEqual(timeline, ['start', 'refresh']);
    assert.equal(widget.modelOptionsLoading, false);
    assert.equal(widget.newSessionModel, 'grok-fixture');
});

test('opening an attached project prewarms an untrusted runtime once without waiting for input', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const warmed = deferred();
    let timer;
    let starts = 0;
    const originalSetTimeout = global.window.setTimeout;
    const originalClearTimeout = global.window.clearTimeout;
    global.window.setTimeout = callback => {
        timer = callback;
        return 1;
    };
    global.window.clearTimeout = () => { timer = undefined; };
    try {
        widget.prompt = '';
        widget.draftImages = [];
        widget.imageReadsInFlight = 0;
        widget.submission = undefined;
        widget.sessionLoading = false;
        widget.runtimePrewarmRequested = true;
        widget.runtimePrewarmTimer = undefined;
        widget.runtimePrewarmAttemptKey = undefined;
        widget.roots = ['/fixture'];
        widget.providers = [{ id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription' }];
        widget.model = {
            snapshot: {
                phase: 'stopped',
                workspaceRoot: '/fixture',
                workspaceAttached: true,
                workspaceTrusted: false,
                providerId: 'grok-subscription',
                models: [],
                sessions: [],
                permissionMode: 'request-approval'
            },
            refresh: async () => {
                widget.model.snapshot.phase = 'ready';
                warmed.resolve();
            }
        };
        widget.service = {
            startRuntime: async () => {
                starts += 1;
                return { ...widget.model.snapshot, phase: 'ready' };
            }
        };
        widget.update = () => undefined;

        assert.equal(widget.composerGate({ ...widget.model.snapshot, phase: 'starting' }), undefined);
        assert.equal(widget.composerGate({ ...widget.model.snapshot, phase: 'initializing' }), undefined);
        widget.requestRuntimePrewarm(true);
        assert.equal(typeof timer, 'function');
        timer();
        await warmed.promise;
        widget.scheduleRuntimePrewarm();

        assert.equal(starts, 1);
        assert.equal(widget.runtimePrewarmRequested, false);
    } finally {
        global.window.setTimeout = originalSetTimeout;
        global.window.clearTimeout = originalClearTimeout;
    }
});

test('project prewarm hydrates an active history session before its next prompt', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    widget.runtimePrewarmRequested = true;
    widget.runtimePrewarmAttemptKey = 'fixture-key';
    widget.activeSessionHydrationKey = undefined;
    widget.roots = ['/fixture'];
    widget.model = {
        snapshot: {
            phase: 'stopped',
            workspaceRoot: '/fixture',
            workspaceAttached: true,
            workspaceTrusted: false,
            providerId: 'grok-subscription',
            activeSessionId: 'session-a',
            models: [],
            sessions: [],
            permissionMode: 'request-approval'
        },
        refresh: async () => {
            timeline.push('refresh');
            widget.model.snapshot.phase = 'ready';
        }
    };
    widget.service = {
        startRuntime: async () => {
            timeline.push('start');
            return { ...widget.model.snapshot, phase: 'ready' };
        },
        loadSession: async sessionId => {
            timeline.push(`load:${sessionId}`);
        }
    };
    widget.update = () => undefined;

    await widget.prewarmRuntime('/fixture', 'grok-subscription', 'fixture-key');

    assert.deepEqual(timeline, ['start', 'refresh', 'load:session-a']);
    assert.equal(widget.activeSessionHydrationKey, '/fixture\u0000grok-subscription\u0000session-a');
    assert.equal(widget.runtimePrewarmRequested, false);
});

test('a workspace fresh page prewarms the runtime without loading prior history', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    const prior = session('prior', 'completed', { workspaceRoot: '/fixture' });
    widget.runtimePrewarmRequested = true;
    widget.runtimePrewarmAttemptKey = 'fixture-new-session';
    widget.activeSessionHydrationKey = undefined;
    widget.roots = ['/fixture'];
    widget.model = {
        snapshot: {
            ...runtimeSnapshot('/fixture', [prior], undefined),
            phase: 'stopped'
        },
        refresh: async () => {
            timeline.push('refresh');
            widget.model.snapshot.phase = 'ready';
            // A stale backend snapshot must still be normalized by the real
            // view model before this method is called. This fixture therefore
            // deliberately retains history but no active selection.
            widget.model.snapshot.activeSessionId = undefined;
        }
    };
    widget.service = {
        startRuntime: async () => {
            timeline.push('start');
            return { ...widget.model.snapshot, phase: 'ready' };
        },
        loadSession: async sessionId => {
            timeline.push(`load:${sessionId}`);
        }
    };
    widget.update = () => undefined;

    await widget.prewarmRuntime('/fixture', 'grok-subscription', 'fixture-new-session');

    assert.deepEqual(timeline, ['start', 'refresh']);
    assert.equal(widget.activeSessionHydrationKey, undefined);
    assert.equal(widget.model.snapshot.sessions[0].appSessionId, 'prior');
    assert.equal(widget.runtimePrewarmRequested, false);
});

test('the first send from a workspace fresh page creates a session instead of loading history', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    const prior = session('prior', 'completed', { workspaceRoot: '/fixture' });
    const created = session('created', 'idle', { workspaceRoot: '/fixture' });
    const snapshot = runtimeSnapshot('/fixture', [prior], undefined);

    widget.prompt = 'inspect this project';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.submission = undefined;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.runtimePrewarmTimer = undefined;
    widget.retryablePrompt = undefined;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.textarea = null;
    widget.model = {
        snapshot,
        startNewSession: () => { snapshot.activeSessionId = undefined; },
        setSession: selected => {
            snapshot.sessions.unshift(selected);
            snapshot.activeSessionId = selected.appSessionId;
        }
    };
    widget.commandService = {
        executeCommand: async () => { timeline.push('save-all'); }
    };
    widget.service = {
        createSession: async () => {
            timeline.push('session/new');
            return created;
        },
        loadSession: async sessionId => {
            timeline.push(`session/load:${sessionId}`);
            return prior;
        },
        sendPrompt: async request => {
            timeline.push(`session/prompt:${request.sessionId}`);
        }
    };
    widget.messages = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
    };
    widget.update = () => undefined;

    await widget.send();

    assert.deepEqual(timeline, ['save-all', 'session/new', 'session/prompt:created']);
    assert.equal(snapshot.activeSessionId, 'created');
    assert.equal(snapshot.sessions.some(candidate => candidate.appSessionId === 'prior'), true);
});

test('cached local history becomes visible before ACP session restore completes', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const restore = deferred();
    const timeline = [];
    const history = [{ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'cached A' }];

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.roots = ['/fixture'];
    widget.openPopover = 'history';
    widget.sessionLoading = false;
    widget.service = {
        getSessionHistory: async () => {
            timeline.push('history-read');
            return history;
        },
        loadSession: async () => {
            timeline.push('restore-start');
            return restore.promise;
        }
    };
    widget.model = {
        snapshot: { activeSessionId: undefined, workspaceRoot: '/fixture', providerId: 'grok-subscription' },
        showSessionHistory: selected => {
            widget.model.snapshot.activeSessionId = selected.appSessionId;
            timeline.push('history-visible');
        },
        updateSession: () => timeline.push('session-restored')
    };
    widget.messages = { error: () => timeline.push('error') };
    widget.update = () => undefined;
    widget.followTranscript = () => undefined;

    const opening = widget.openSession(session('a'));
    await new Promise(resolve => setImmediate(resolve));
    const visibleBeforeRestore = timeline.includes('history-visible');
    restore.resolve({});
    await opening;

    assert.equal(visibleBeforeRestore, true, `timeline before restore: ${timeline.join(' -> ')}`);
});

test('a project context change invalidates an in-flight widget session restore', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const restore = deferred();
    const timeline = [];

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.roots = ['/fixture'];
    widget.openPopover = 'history';
    widget.sessionLoading = false;
    widget.service = {
        getSessionHistory: async () => [],
        loadSession: async () => {
            timeline.push('restore-start');
            return restore.promise;
        }
    };
    widget.model = {
        snapshot: { activeSessionId: undefined, workspaceRoot: '/fixture', providerId: 'grok-subscription' },
        showSessionHistory: selected => {
            widget.model.snapshot.activeSessionId = selected.appSessionId;
            timeline.push('history-visible');
        },
        updateSession: () => timeline.push('session-restored')
    };
    widget.messages = { error: () => timeline.push('error') };
    widget.update = () => undefined;
    widget.followTranscript = () => undefined;

    const opening = widget.openSession(session('a'));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(timeline.includes('restore-start'));

    widget.model.snapshot.workspaceRoot = '/other-project';
    widget.reconcileAgentContext();
    restore.resolve(session('a'));
    await opening;

    assert.equal(widget.sessionLoading, false);
    assert.equal(timeline.includes('session-restored'), false);
});

test('a maximum-sized history is reduced with one notification and a bounded view-model cost', () => {
    const model = new AgentViewModel();
    let changes = 0;
    const disposable = model.onDidChange(() => changes++);
    const history = Array.from({ length: 5000 }, (_, index) => ({
        kind: 'tool-call',
        sessionId: 'a',
        toolCallId: `tool-${index}`,
        title: `tool-${index}`,
        toolName: 'filesystem/read_file',
        status: 'completed',
        input: { path: `/fixture/file-${index}.ts` },
        output: 'done'
    }));

    const started = performance.now();
    model.loadHistory(history);
    const elapsed = performance.now() - started;
    disposable.dispose();

    assert.equal(changes, 1);
    assert.ok(model.transcript.length > 0 && model.transcript.length <= 5000);
    // This budget covers reduction only. DOM rendering needs its own windowing
    // or incremental-render contract in the widget.
    assert.ok(elapsed < 750, `history reduction took ${elapsed.toFixed(1)} ms`);
});
