const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const { AgentViewModel } = require('../lib/browser/agent-view-model');
const {
    agentModelChoiceGroups,
    encodeAgentModelConfiguration,
    encodeAgentModelChoice,
    PROVIDER_DEFAULT_MODEL_CHOICE_ID
} = require('../lib/browser/agent-model-options');
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

async function waitForRequestCount(requests, expected) {
    for (let attempt = 0; attempt < 20 && requests.length < expected; attempt += 1) {
        await Promise.resolve();
    }
    assert.equal(requests.length, expected);
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
        list: () => [...records.values()],
        update: (id, patch) => {
            const updated = { ...records.get(id), ...patch };
            records.set(id, updated);
            return updated;
        }
    };
    host.providers = {
        runtimeEpoch: () => 'legacy-v1',
        selectedProviderId: () => 'grok-subscription',
        preferredModelId: () => undefined,
        get: id => id === 'grok-subscription'
            ? { id, name: 'Grok 订阅', kind: 'grok-subscription' }
            : undefined,
        selectPreferredModel: () => undefined
    };
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.restoringSessionCounts = new Map();
    host.sessionLoadGeneration = 0;
    host.runtimeGeneration = 1;
    host.runtimeProviderEpoch = 'legacy-v1';
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

test('file review opens immutable before and after snapshots in the native Theia Diff editor', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const beforePath = path.resolve('/history/before-example.ts');
    const afterPath = path.resolve('/history/after-example.ts');
    const opened = [];
    const notices = [];
    widget.model = { snapshot: { workspaceRoot: '/fixture' } };
    widget.diffService = {
        openDiffEditor: async (...args) => opened.push(args)
    };
    widget.showInlineNotice = (...args) => notices.push(args);

    await widget.openDiff({
        kind: 'diff',
        diffId: 'diff-a',
        sessionId: 'a',
        path: 'src/example.ts',
        oldPath: beforePath,
        newPath: afterPath,
        oldHash: 'a'.repeat(64),
        newHash: 'b'.repeat(64),
        diff: '-before\n+after'
    });

    assert.equal(opened.length, 1);
    assert.equal(opened[0][0].path.fsPath(), beforePath);
    assert.equal(opened[0][1].path.fsPath(), afterPath);
    assert.equal(opened[0][2], 'example.ts（Agent 修改）');
    assert.deepEqual(notices, []);
});

test('file navigation resolves exact multi-root paths, nested suffix paths and full-access external files', async () => {
    const { FileUri } = require('@theia/core/lib/common/file-uri');
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const nativePath = value => FileUri.fsPath(FileUri.create(path.resolve(value)));
    const mainRoot = nativePath('/workspace/hello-doc');
    const additionalRoot = nativePath('/workspace/shared-docs');
    const nestedChinese = path.join(mainRoot, '技术分享', '示例项目', '材料', '案例-滴滴估价-抓包样例.md');
    const exactAdditional = path.join(additionalRoot, '规范', '接口说明.md');
    const external = nativePath('/external/交付文档/检查清单.md');
    const existing = new Set([nestedChinese, exactAdditional, external]);
    widget.model = {
        snapshot: {
            workspaceRoot: mainRoot,
            permissionMode: 'request-approval'
        }
    };
    widget.roots = [mainRoot, additionalRoot];
    widget.pathPlatform = () => process.platform === 'win32' ? 'win32' : 'linux';
    widget.fileService = {
        exists: async uri => existing.has(FileUri.fsPath(uri))
    };
    widget.fileSearchService = {
        find: async (pattern, options) => {
            assert.equal(pattern, '材料/案例-滴滴估价-抓包样例.md');
            assert.deepEqual(options.rootUris, [FileUri.create(mainRoot).toString(), FileUri.create(additionalRoot).toString()]);
            return [FileUri.create(nestedChinese).toString()];
        }
    };

    assert.equal(FileUri.fsPath(await widget.resolveWorkspaceFileUri('规范/接口说明.md')), exactAdditional);
    assert.equal(
        FileUri.fsPath(await widget.resolveWorkspaceFileUri('材料/案例-滴滴估价-抓包样例.md')),
        nestedChinese,
        'a unique nested suffix must repair an Agent path relative to a deeper tool cwd'
    );
    assert.equal(await widget.resolveWorkspaceFileUri(external), undefined,
        'request-approval must not open an absolute file outside every workspace root');
    widget.model.snapshot.permissionMode = 'full-access';
    assert.equal(FileUri.fsPath(await widget.resolveWorkspaceFileUri(external)), external,
        'full access must allow an existing absolute file elsewhere on disk');
    assert.equal(
        FileUri.fsPath(await widget.resolveWorkspaceFileUri(FileUri.create(external).toString())),
        external,
        'already encoded file URIs must be decoded exactly once'
    );

    widget.fileSearchService.find = async () => [
        FileUri.create(path.join(mainRoot, '项目甲', '材料', '同名说明.md')).toString(),
        FileUri.create(path.join(mainRoot, '项目乙', '材料', '同名说明.md')).toString()
    ];
    assert.equal(await widget.resolveWorkspaceFileUri('材料/同名说明.md'), undefined,
        'equally ranked suffix matches must fail closed instead of opening the wrong file');
    assert.equal(await widget.resolveWorkspaceFileUri('../工作区外.md'), undefined,
        'relative traversal must never escape a workspace root');
});

test('only an unconfirmed local create survives missing snapshots and a newer post-confirmation deletion clears it', () => {
    const model = new AgentViewModel();
    const created = session('created', 'idle', {
        providerId: 'xora-relay',
        model: 'xora-relay',
        authorityRevision: 3
    });
    const initial = {
        ...runtimeSnapshot('/fixture', [], undefined),
        revision: 2,
        providerId: 'xora-relay',
        models: [{ id: 'xora-relay', name: 'Relay' }],
        selectedModel: 'xora-relay'
    };
    model.accept({ kind: 'snapshot', snapshot: { ...initial, sessions: [] } });
    model.setSession(created, true);

    // Event and RPC responses travel independently. An older Provider A
    // event must not overwrite the newer Provider B RPC result.
    model.accept({
        kind: 'snapshot',
        snapshot: {
            ...runtimeSnapshot('/fixture', [], undefined),
            revision: 1,
            providerId: 'grok-subscription'
        }
    });
    assert.equal(model.snapshot.providerId, 'xora-relay');

    // This snapshot was emitted before session/new completed, but can arrive
    // after its RPC result and the renderer's setSession(created).
    model.accept({ kind: 'snapshot', snapshot: { ...initial, sessions: [] } });

    assert.equal(model.snapshot.activeSessionId, created.appSessionId);
    assert.equal(model.snapshot.sessions[0].appSessionId, created.appSessionId);
    model.accept({ kind: 'text-delta', sessionId: created.appSessionId, role: 'user', text: 'hello' });
    assert.deepEqual(model.transcript.map(entry => entry.text), ['hello']);

    // A revision-less compatibility event from the prior Provider cannot
    // cross the locally-created Provider boundary.
    model.accept({
        kind: 'snapshot',
        snapshot: { ...runtimeSnapshot('/fixture', [], undefined), providerId: 'grok-subscription' }
    });
    assert.equal(model.snapshot.providerId, 'xora-relay');
    assert.equal(model.snapshot.activeSessionId, created.appSessionId);

    // The first authoritative snapshot containing the id ends the temporary
    // session/new race protection.
    model.accept({
        kind: 'snapshot',
        snapshot: { ...initial, revision: 3, sessions: [created], activeSessionId: created.appSessionId }
    });
    assert.equal(model.snapshot.activeSessionId, created.appSessionId);

    // Equal-revision delivery can still be out of order and must not erase
    // the confirmed selection. A newer missing snapshot is authoritative.
    model.accept({ kind: 'snapshot', snapshot: { ...initial, revision: 3, sessions: [] } });
    assert.equal(model.snapshot.activeSessionId, created.appSessionId);
    model.accept({ kind: 'snapshot', snapshot: { ...initial, revision: 4, sessions: [] } });
    assert.equal(model.snapshot.activeSessionId, undefined);
    assert.equal(model.transcript.length, 0);
});

test('a normal history selection is never granted unconfirmed-create protection', () => {
    const model = new AgentViewModel();
    const history = session('history', 'completed');
    model.accept({
        kind: 'snapshot',
        snapshot: { ...runtimeSnapshot('/fixture', [history], history.appSessionId), revision: 5 }
    });
    model.setSession(history);
    model.loadHistory([{ kind: 'text-delta', sessionId: history.appSessionId, role: 'assistant', text: 'old' }]);

    model.accept({
        kind: 'snapshot',
        snapshot: { ...runtimeSnapshot('/fixture', [], undefined), revision: 6 }
    });

    assert.equal(model.snapshot.activeSessionId, undefined);
    assert.equal(model.snapshot.sessions.some(item => item.appSessionId === history.appSessionId), false);
    assert.equal(model.transcript.length, 0);
});

test('a create authority fence preserves any number of older snapshots and rejects a newer omission', () => {
    const model = new AgentViewModel();
    const created = session('created', 'idle', { authorityRevision: 7 });
    const initial = { ...runtimeSnapshot('/fixture', [], undefined), revision: 2 };
    model.accept({ kind: 'snapshot', snapshot: initial });
    model.setSession(created, true);

    // Multiple snapshots can be produced while session/new awaits ACP and
    // cross its RPC result. Their exact revision fence, rather than an
    // omission count, proves that all of them predate the created record.
    model.accept({ kind: 'snapshot', snapshot: { ...initial, revision: 4 } });
    assert.equal(model.snapshot.activeSessionId, created.appSessionId);
    model.accept({ kind: 'snapshot', snapshot: { ...initial, revision: 6 } });
    assert.equal(model.snapshot.activeSessionId, created.appSessionId);
    model.accept({
        kind: 'snapshot',
        snapshot: { ...initial, revision: 5, sessions: [created], activeSessionId: created.appSessionId }
    });
    model.accept({ kind: 'snapshot', snapshot: { ...initial, revision: 7 } });
    assert.equal(model.snapshot.activeSessionId, created.appSessionId);
    model.accept({ kind: 'snapshot', snapshot: { ...initial, revision: 8 } });

    assert.equal(model.snapshot.activeSessionId, undefined);
    assert.equal(model.snapshot.sessions.some(item => item.appSessionId === created.appSessionId), false);
    model.accept({ kind: 'session', session: created });
    assert.equal(model.snapshot.sessions.some(item => item.appSessionId === created.appSessionId), false);
});

test('equal-revision snapshots preserve global history across workspace and Provider boundaries', () => {
    const model = new AgentViewModel();
    const active = session('active', 'idle');
    const background = session('background', 'completed', {
        workspaceRoot: '/another-project',
        providerId: 'xora-relay'
    });
    model.accept({
        kind: 'snapshot',
        snapshot: { ...runtimeSnapshot('/fixture', [active, background], active.appSessionId), revision: 8 }
    });

    model.accept({
        kind: 'snapshot',
        snapshot: { ...runtimeSnapshot('/fixture', [active], active.appSessionId), revision: 8 }
    });
    assert.deepEqual(model.snapshot.sessions.map(item => item.appSessionId), ['active', 'background']);

    model.accept({
        kind: 'snapshot',
        snapshot: { ...runtimeSnapshot('/fixture', [active], active.appSessionId), revision: 9 }
    });
    assert.deepEqual(model.snapshot.sessions.map(item => item.appSessionId), ['active']);
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

test('explicit old-Provider history stays visible while Electron rebinds it to the global Provider', () => {
    const model = new AgentViewModel();
    const historical = session('old-provider-visible', 'completed', {
        providerId: 'old-relay',
        model: 'old-model'
    });
    model.snapshot = runtimeSnapshot('/fixture', [historical], undefined);
    model.showSessionHistory(historical, [
        { kind: 'text-delta', sessionId: historical.appSessionId, role: 'assistant', text: '保留的历史内容' }
    ]);

    model.accept({
        kind: 'snapshot',
        snapshot: runtimeSnapshot('/fixture', [historical], undefined)
    });

    assert.equal(model.snapshot.providerId, 'grok-subscription');
    assert.equal(model.snapshot.activeSessionId, historical.appSessionId);
    assert.deepEqual(model.transcript.map(entry => entry.text), ['保留的历史内容']);

    const rebound = {
        ...historical,
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'subscription-epoch',
        model: 'grok',
        status: 'idle'
    };
    model.accept({ kind: 'session', session: rebound });

    assert.equal(model.snapshot.activeSessionId, historical.appSessionId);
    assert.equal(model.snapshot.sessions.find(item => item.appSessionId === historical.appSessionId).providerId, 'grok-subscription');
    assert.deepEqual(model.transcript.map(entry => entry.text), ['保留的历史内容']);
});

test('workspace activation restores the latest local conversation across A-B-A and deduplicates same-root events', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const model = new AgentViewModel();
    const sessionAOld = session('a-old', 'completed', { workspaceRoot: '/workspace-a', updatedAt: '2026-01-01T00:00:00.000Z' });
    const sessionA = session('a', 'completed', { workspaceRoot: '/workspace-a', updatedAt: '2026-02-01T00:00:00.000Z' });
    const sessionB = session('b', 'completed', { workspaceRoot: '/workspace-b' });
    let prewarms = 0;
    const opened = [];

    model.accept({ kind: 'snapshot', snapshot: runtimeSnapshot('/workspace-a', [sessionA, sessionB, sessionAOld], undefined) });
    model.refresh = async () => undefined;
    widget.model = model;
    widget.roots = ['/workspace-a'];
    widget.workspaceRestoreGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.sessionLoadGeneration = 0;
    widget.invalidateAgentContext = () => undefined;
    widget.requestRuntimePrewarm = () => { prewarms += 1; };
    widget.update = () => undefined;
    widget.workspaceTrustGuard = {
        selectWorkspaceRoot: async root => {
            model.snapshot.workspaceRoot = root;
            model.snapshot.activeSessionId = undefined;
        }
    };
    widget.openSession = async selected => {
        opened.push(selected.appSessionId);
        model.showSessionHistory(selected, [{
            kind: 'text-delta', sessionId: selected.appSessionId, role: 'assistant', text: `history ${selected.appSessionId}`
        }]);
    };

    const activate = async root => {
        widget.activateWorkspace([root]);
        await widget.workspaceRestorePromise;
    };

    await activate('/workspace-a');
    assert.equal(model.snapshot.activeSessionId, 'a');
    assert.deepEqual(model.transcript.map(entry => entry.text), ['history a']);

    // Duplicate root discovery from refreshRoots must not reopen the session.
    await activate('/workspace-a');
    await activate('/workspace-b');
    assert.equal(model.snapshot.activeSessionId, 'b');
    await activate('/workspace-a');
    assert.equal(model.snapshot.activeSessionId, 'a');

    assert.deepEqual(opened, ['a', 'b', 'a']);
    assert.equal(prewarms, 4);
});

test('rapid tool completion keeps Agent activity roots collapsed and structurally stable', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    widget.toolDisclosure = new Map();
    const entry = {
        id: 'tool-session-a-edit-1',
        kind: 'tool',
        payload: {
            kind: 'tool-call',
            sessionId: 'session-a',
            toolCallId: 'edit-1',
            title: 'Edit file',
            toolName: 'apply_patch',
            status: 'running',
            startedAt: '2026-07-23T00:00:00.000Z',
            presentation: {
                action: 'file-write',
                source: 'builtin',
                targetLabel: 'lab-pages.ts'
            }
        }
    };

    widget.agentPaneView = 'conversation';
    const runningGroup = widget.renderTranscript([entry])[0];
    entry.payload = { ...entry.payload, status: 'completed', elapsedMs: 1_250 };
    const completedGroup = widget.renderTranscript([entry])[0];

    assert.equal(runningGroup.type, 'details');
    assert.equal(runningGroup.key, completedGroup.key);
    assert.equal(runningGroup.props.open, false);
    assert.equal(completedGroup.props.open, false);
    assert.equal(runningGroup.props.children[1], undefined, 'a running summary must not transiently mount its large body');
    assert.match(JSON.stringify(runningGroup), /修改文件 · lab-pages\.ts/);

    widget.agentPaneView = 'activity';
    const firstActivityCard = widget.renderTranscript([entry])[0];
    const secondEntry = {
        ...entry,
        id: 'tool-session-a-test-2',
        payload: {
            ...entry.payload,
            toolCallId: 'test-2',
            title: 'Run tests',
            toolName: 'run_tests',
            presentation: { action: 'test', source: 'builtin' }
        }
    };
    const activityCards = widget.renderTranscript([entry, secondEntry]);
    assert.equal(activityCards.length, 2);
    assert.equal(firstActivityCard.type, activityCards[0].type);
    assert.equal(firstActivityCard.key, activityCards[0].key,
        'adding a second activity must not replace the first card with a new group root');
    assert.equal(activityCards[0].props.open, false);
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

test('two unloaded sessions hydrate concurrently while only the latest activation takes focus', async () => {
    const { host, requests } = hostHarness();

    const firstA = host.loadSession('a');
    const latestB = host.loadSession('b');

    await waitForRequestCount(requests, 2);
    assert.equal(requests.length, 2, 'each unloaded session must begin hydration without waiting for the other');
    assert.deepEqual(requests.map(request => request.params.sessionId), ['acp-a', 'acp-b']);

    requests[1].completion.resolve({});
    const loadedB = await latestB;
    assert.equal(loadedB.appSessionId, 'b');
    assert.equal(host.activeSessionId, 'b');
    assert.ok(host.loadedSessionIds.has('b'));

    requests[0].completion.resolve({});
    const loadedA = await firstA;
    assert.equal(loadedA.appSessionId, 'a');
    assert.deepEqual([...host.loadedSessionIds].sort(), ['a', 'b']);
    assert.equal(host.activeSessionId, 'b', 'late background hydration must not steal the latest visible tab');
});

test('A-B-A activation coalesces A hydration and the final A intent wins', async () => {
    const { host, requests } = hostHarness();

    const firstA = host.loadSession('a');
    const middleB = host.loadSession('b');
    const latestA = host.loadSession('a');

    await waitForRequestCount(requests, 2);
    assert.equal(requests.length, 2, 'the second A intent must reuse its in-flight session/load');
    assert.deepEqual(requests.map(request => request.params.sessionId), ['acp-a', 'acp-b']);

    // Finish B first to prove its completion cannot override the later A
    // activation, then release the single shared A hydration.
    requests[1].completion.resolve({});
    await middleB;
    assert.equal(host.activeSessionId, undefined, 'a stale B activation must not take focus');

    requests[0].completion.resolve({});
    const [loadedFirstA, loadedLatestA] = await Promise.all([firstA, latestA]);

    assert.equal(loadedFirstA.appSessionId, 'a');
    assert.equal(loadedLatestA.appSessionId, 'a');
    assert.deepEqual([...host.loadedSessionIds].sort(), ['a', 'b']);
    assert.equal(host.activeSessionId, 'a');
});

test('prewarm and Send coalesce one in-flight restore for the same session', async () => {
    const { host, requests } = hostHarness();

    const prewarm = host.loadSession('a');
    const sendGuard = host.loadSession('a');

    await waitForRequestCount(requests, 1);
    assert.equal(requests.length, 1, 'the same activation intent must issue only one ACP session/load');
    assert.equal(requests[0].method, 'session/load');
    requests[0].completion.resolve({});
    const [first, second] = await Promise.all([prewarm, sendGuard]);

    assert.equal(first.appSessionId, 'a');
    assert.equal(second.appSessionId, 'a');
    assert.equal(host.activeSessionId, 'a');
    assert.ok(host.loadedSessionIds.has('a'));
});

test('a same-Provider runtime restart never reuses the previous sidecar load', async () => {
    const { host, requests } = hostHarness();

    const oldRuntimeLoad = host.loadSession('a');
    const obsoleteLoad = assert.rejects(
        oldRuntimeLoad,
        /runtime changed while restoring/i,
        'a restore bound to the replaced process must fail instead of marking the new runtime hydrated'
    );
    await waitForRequestCount(requests, 1);
    assert.equal(requests.length, 1);

    // Simulate a sidecar replacement that retained the same workspace,
    // Provider and credential epoch. runtimeGeneration is the remaining hard
    // process-identity boundary.
    host.runtimeGeneration += 1;
    host.loadedSessionIds.clear();
    const newRuntimeLoad = host.loadSession('a');

    await waitForRequestCount(requests, 2);
    assert.equal(requests.length, 2, 'the restarted sidecar requires its own ACP session/load');
    assert.equal(requests[1].method, 'session/load');
    requests[0].completion.resolve({});
    requests[1].completion.resolve({});
    await Promise.all([obsoleteLoad, newRuntimeLoad]);

    assert.equal(host.activeSessionId, 'a');
    assert.ok(host.loadedSessionIds.has('a'));
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

test('repeated running and completed tool diffs create one event with immutable before and after snapshots', () => {
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
    const diff = emitted.find(event => event.kind === 'diff');
    assert.equal(beforeImages, 2);
    assert.equal(diff.oldPath, '/history/before-1');
    assert.equal(diff.newPath, '/history/before-2');
    assert.equal(host.revertableDiffs.size, 1);
    assert.equal(host.emittedDiffKeys.size, 1);
});

test('safe revert refuses a before-image whose content no longer matches its recorded hash', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const crypto = require('node:crypto');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-safe-revert-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const targetPath = path.join(root, 'edited.ts');
    const beforePath = path.join(root, 'before.ts');
    const before = 'const value = "before";\n';
    const after = 'const value = "after";\n';
    fs.writeFileSync(targetPath, after);
    fs.writeFileSync(beforePath, 'tampered snapshot\n');

    const host = Object.create(GrokAgentHostService.prototype);
    host.workspaceRoot = root;
    host.safeWorkspaceFile = candidate => candidate;
    host.revertableDiffs = new Map([['diff-integrity', {
        targetPath,
        beforePath,
        expectedBeforeHash: crypto.createHash('sha256').update(before).digest('hex'),
        expectedNewHash: crypto.createHash('sha256').update(after).digest('hex')
    }]]);

    await assert.rejects(host.revertDiff('diff-integrity'), /snapshot failed its integrity check/u);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), after, 'the workspace file must remain unchanged');
});

test('backend tool clocks are session-isolated, monotonic and freeze at completion', () => {
    const { host } = hostHarness();
    const emitted = [];
    host.emit = event => emitted.push(event);

    host.acceptToolUpdate('session-a', {
        toolCallId: 'same-id', title: 'Run command', status: 'running'
    }, 'tool_call');
    host.acceptToolUpdate('session-b', {
        toolCallId: 'same-id', title: 'Edit file', status: 'running'
    }, 'tool_call');
    host.acceptToolUpdate('session-a', {
        toolCallId: 'same-id', title: 'Run command', status: 'completed'
    }, 'tool_call_update');
    host.acceptToolUpdate('session-a', {
        toolCallId: 'same-id', title: 'Late update', status: 'running'
    }, 'tool_call_update');

    const sessionA = emitted.filter(event => event.kind === 'tool-call' && event.sessionId === 'session-a');
    const sessionB = emitted.filter(event => event.kind === 'tool-call' && event.sessionId === 'session-b');
    assert.deepEqual(sessionA.map(event => event.status), ['running', 'completed', 'completed']);
    assert.equal(sessionA[0].startedAt, sessionA[1].startedAt);
    assert.equal(sessionA[1].elapsedMs, sessionA[2].elapsedMs);
    assert.equal(Number.isSafeInteger(sessionA[1].elapsedMs), true);
    assert.equal(sessionB.length, 1);
    assert.notEqual(sessionA[0].startedAt, undefined);
    assert.notEqual(sessionB[0].startedAt, undefined);

    host.clearToolActivityTimings('session-a');
    assert.equal([...host.toolActivityTimingState().keys()].some(key => key.startsWith('session-a\0')), false);
    assert.equal([...host.toolActivityTimingState().keys()].some(key => key.startsWith('session-b\0')), true);
});

test('new files produce a zero-line removal diff instead of a phantom minus one', () => {
    const { host } = hostHarness();
    const emitted = [];
    host.workspaceRoot = '/fixture';
    host.emittedDiffKeys = new Set();
    host.revertableDiffs = new Map();
    host.safeWorkspaceFile = candidate => path.normalize(candidate);
    host.sessions.saveBeforeImage = () => ({ path: '/history/empty', hash: 'empty-hash' });
    host.emit = event => emitted.push(event);

    host.acceptToolUpdate('session-a', {
        toolCallId: 'create-1',
        title: 'Create file',
        status: 'completed',
        content: [{ type: 'diff', path: 'new.ts', oldText: '', newText: 'one\ntwo\n' }]
    }, 'tool_call_update');

    const diff = emitted.find(event => event.kind === 'diff').diff;
    const tool = emitted.find(event => event.kind === 'tool-call');
    assert.equal(tool.elapsedMs, undefined, 'a terminal-only notification must not invent a duration');
    assert.doesNotMatch(diff, /^-$/m);
    assert.equal(diff.split(/\r?\n/).filter(line => line.startsWith('-') && !line.startsWith('---')).length, 0);
    assert.equal(diff.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).length, 2);
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
        get: id => ({ id, name: id, kind: id === 'grok-subscription' ? 'grok-subscription' : 'custom' }),
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
    const switching = host.selectProvider('xora-relay');
    host.activePrompts.set('turn', {});
    startGate.resolve();

    await starting;
    await assert.rejects(switching, /Cancel or finish the current task/);
    assert.equal(selected, false);
    assert.equal(host.providerId, 'grok-subscription');
});

test('editing the current API profile preserves history but cannot auto-restore it against a new endpoint', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let profile = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://old.example.invalid/v1',
        model: 'grok-4.5',
        secretRef: 'provider:xora-relay',
        credentialConfigured: true
    };
    const messages = [];
    host.lifecycleTail = Promise.resolve();
    host.providers = {
        get: id => id === profile.id ? profile : undefined,
        save: next => {
            profile = { ...next, credentialConfigured: true };
            return profile;
        }
    };
    host.providerId = profile.id;
    host.phase = 'stopped';
    host.acp = undefined;
    host.supervisor = { running: false };
    host.activeSessionId = 'historical-session';
    host.sessionLoadGeneration = 4;
    host.loadedSessionIds = new Set(['historical-session']);
    host.sessions = { markProviderSessionsReadOnly: () => [], list: () => [] };
    host.models = [];
    host.onProviderDefaultsChanged = () => undefined;
    const invalidations = [];
    host.onProviderRuntimeInvalidated = change => invalidations.push(change);
    host.emitSnapshot = message => messages.push(message);

    await host.saveProvider({ ...profile, baseUrl: 'https://new.example.invalid/v1' });

    assert.equal(host.activeSessionId, undefined);
    assert.equal(host.sessionLoadGeneration, 5);
    assert.deepEqual([...host.loadedSessionIds], []);
    assert.equal(host.selectedModel, profile.id);
    assert.match(messages.at(-1), /会话隔离.*新会话/);
    assert.deepEqual(invalidations, [{
        providerId: profile.id,
        reason: 'configuration',
        invalidateSession: true
    }]);
});

test('editing only custom reasoning capabilities restarts the stale runtime before its rotated epoch can be used', async () => {
    let profile = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.6',
        reasoning: { options: ['high'], defaultEffort: 'high' },
        secretRef: 'provider:xora-relay',
        credentialConfigured: true
    };
    const host = Object.create(GrokAgentHostService.prototype);
    let stops = 0;
    host.lifecycleTail = Promise.resolve();
    host.providers = {
        get: id => id === profile.id ? profile : undefined,
        save: next => {
            profile = { ...next, credentialConfigured: true };
            return profile;
        }
    };
    host.providerId = profile.id;
    host.phase = 'ready';
    host.supervisor = { running: true };
    host.acp = {};
    host.activeSessionId = 'historical-session';
    host.sessionLoadGeneration = 1;
    host.loadedSessionIds = new Set(['historical-session']);
    host.sessions = { markProviderSessionsReadOnly: () => [], list: () => [] };
    host.activePrompts = new Map();
    host.stopRuntimeLocked = async () => {
        stops += 1;
        host.phase = 'stopped';
        host.supervisor.running = false;
        host.acp = undefined;
        host.models = [];
    };
    host.onProviderDefaultsChanged = () => undefined;
    const invalidations = [];
    host.onProviderRuntimeInvalidated = change => invalidations.push(change);
    host.emitSnapshot = () => undefined;

    await host.saveProvider({
        ...profile,
        reasoning: { options: ['high', 'xhigh'], defaultEffort: 'xhigh' }
    });

    assert.equal(stops, 1);
    assert.equal(host.activeSessionId, undefined);
    assert.equal(host.sessionLoadGeneration, 2);
    assert.deepEqual(invalidations, [{
        providerId: profile.id,
        reason: 'configuration',
        invalidateSession: true
    }]);
});

test('a Provider invalidation clears matching stopped peers but never touches another Provider', async () => {
    const createPeer = providerId => {
        const host = Object.create(GrokAgentHostService.prototype);
        host.lifecycleTail = Promise.resolve();
        host.providerId = providerId;
        host.phase = 'stopped';
        host.supervisor = { running: false };
        host.acp = undefined;
        host.managementChild = undefined;
        host.activeSessionId = 'old-session';
        host.loadedSessionIds = new Set(['old-session']);
        host.sessionLoadGeneration = 8;
        host.providers = {
            get: id => ({
                id,
                name: id,
                kind: id === 'xora-relay' ? 'custom' : 'grok-subscription',
                model: id === 'xora-relay' ? 'grok-4.5' : undefined
            }),
            preferredModelId: () => undefined,
            subscriptionAuthStatus: () => 'unknown'
        };
        host.sessions = { list: () => [], markProviderSessionsReadOnly: () => [] };
        host.emitSnapshot = () => undefined;
        host.emitError = (_code, error) => { throw error; };
        return host;
    };
    const matching = createPeer('xora-relay');
    const unrelated = createPeer('grok-subscription');
    const change = { providerId: 'xora-relay', reason: 'configuration', invalidateSession: true };

    matching.notifyProviderRuntimeInvalidated(change);
    unrelated.notifyProviderRuntimeInvalidated(change);
    await Promise.all([matching.lifecycleTail, unrelated.lifecycleTail]);

    assert.equal(matching.activeSessionId, undefined);
    assert.deepEqual([...matching.loadedSessionIds], []);
    assert.equal(matching.sessionLoadGeneration, 9);
    assert.equal(unrelated.activeSessionId, 'old-session');
    assert.deepEqual([...unrelated.loadedSessionIds], ['old-session']);
    assert.equal(unrelated.sessionLoadGeneration, 8);
});

test('an idle window adopts a globally selected Provider even when it has an old active history', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let stops = 0;
    host.lifecycleTail = Promise.resolve();
    host.providerId = 'old-relay';
    host.selectedModel = 'old-relay';
    host.phase = 'ready';
    host.acp = {};
    host.supervisor = { running: false };
    host.managementChild = undefined;
    host.activePrompts = new Map();
    host.activeSessionId = 'old-history';
    host.loadedSessionIds = new Set(['old-history']);
    host.sessionLoadGeneration = 6;
    host.models = [{ id: 'old-relay', name: 'Old relay' }];
    host.sessions = { list: () => [session('old-history', 'idle', { providerId: 'old-relay' })] };
    host.providers = {
        selectedProviderId: () => 'new-relay',
        get: id => ({ id, name: id, kind: 'custom', model: 'grok-4.5' }),
        preferredModelId: () => undefined,
        selectPreferredModel: () => undefined
    };
    host.stopRuntimeLocked = async () => {
        stops += 1;
        host.acp = undefined;
        host.phase = 'stopped';
    };
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };

    host.notifyProviderDefaultsChanged();
    await host.lifecycleTail;

    assert.equal(stops, 1);
    assert.equal(host.providerId, 'new-relay');
    assert.equal(host.selectedModel, 'new-relay');
    assert.equal(host.activeSessionId, undefined);
    assert.deepEqual([...host.loadedSessionIds], []);
    assert.ok(host.sessionLoadGeneration > 6, 'stale session activations must be invalidated');
});

test('an idle loaded session adopts the globally preferred model for its current Provider', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session('idle-session', 'idle', {
        providerId: 'grok-subscription',
        model: 'old-model'
    });
    const requests = [];
    host.lifecycleTail = Promise.resolve();
    host.providerId = 'grok-subscription';
    host.selectedModel = 'old-model';
    host.phase = 'ready';
    host.runtimeProviderEpoch = 'legacy-v1';
    host.supervisor = { running: false };
    host.managementChild = undefined;
    host.activePrompts = new Map();
    host.activeSessionId = record.appSessionId;
    host.loadedSessionIds = new Set([record.appSessionId]);
    host.sessionLoadGeneration = 4;
    host.models = [
        { id: 'old-model', name: 'Old model' },
        { id: 'new-model', name: 'New model' }
    ];
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (_id, patch) => (record = { ...record, ...patch })
    };
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        get: id => ({ id, name: 'Grok 订阅', kind: 'grok-subscription' }),
        preferredModelId: () => 'new-model',
        runtimeEpoch: () => 'legacy-v1',
        selectPreferredModel: () => undefined
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            return {};
        }
    };
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };

    host.notifyProviderDefaultsChanged();
    await host.lifecycleTail;

    assert.deepEqual(requests, [{
        method: 'session/set_model',
        params: { sessionId: record.acpSessionId, modelId: 'new-model' }
    }]);
    assert.equal(host.providerId, 'grok-subscription');
    assert.equal(host.selectedModel, 'new-model');
    assert.equal(host.activeSessionId, record.appSessionId);
    assert.equal(record.model, 'new-model');
});

test('a global Provider switch waits for the active turn and applies immediately after it finishes', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session('running-session', 'idle', {
        providerId: 'old-relay',
        model: 'old-relay'
    });
    const promptGate = deferred();
    let stops = 0;
    host.lifecycleTail = Promise.resolve();
    host.providerId = 'old-relay';
    host.selectedModel = 'old-relay';
    host.workspaceRoot = '/fixture';
    host.phase = 'ready';
    host.runtimeProviderEpoch = 'legacy-v1';
    host.supervisor = { running: false };
    host.managementChild = undefined;
    host.activeSessionId = record.appSessionId;
    host.loadedSessionIds = new Set([record.appSessionId]);
    host.activePrompts = new Map();
    host.sessionLoadGeneration = 2;
    host.models = [{ id: 'old-relay', name: 'Old relay' }];
    host.capabilities = { prompt: { image: false } };
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (_id, patch) => (record = { ...record, ...patch }),
        flushEvents: () => undefined
    };
    let globallySelectedProvider = 'old-relay';
    host.providers = {
        selectedProviderId: () => globallySelectedProvider,
        get: id => ({ id, name: id, kind: 'custom', model: 'grok-4.5' }),
        preferredModelId: () => undefined,
        runtimeEpoch: () => 'legacy-v1',
        selectPreferredModel: () => undefined
    };
    host.acp = {
        startRequest: () => ({
            promise: promptGate.promise,
            cancel: async () => undefined
        })
    };
    host.stopRuntimeLocked = async () => {
        stops += 1;
        host.acp = undefined;
        host.phase = 'stopped';
    };
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.acceptPromptContextFallback = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };

    const sending = host.sendPrompt({ sessionId: record.appSessionId, text: '继续任务' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.activePrompts.size, 1);

    globallySelectedProvider = 'new-relay';
    host.notifyProviderDefaultsChanged();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 0, 'an active turn must not be interrupted');
    assert.equal(host.providerId, 'old-relay');

    promptGate.resolve({ stopReason: 'end_turn' });
    await sending;
    await new Promise(resolve => setImmediate(resolve));
    await host.lifecycleTail;

    assert.equal(stops, 1);
    assert.equal(host.providerId, 'new-relay');
    assert.equal(host.selectedModel, 'new-relay');
    assert.equal(host.activeSessionId, undefined);
});

test('a Provider epoch mismatch rebinds local history to a fresh ACP session without replaying prompts', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session('epoch-old', 'idle', {
        providerId: 'xora-relay',
        providerRuntimeEpoch: 'old-provider-epoch'
    });
    const emitted = [];
    const requests = [];
    let runtimeStarts = 0;
    host.sessionLoadGeneration = 0;
    host.runtimeGeneration = 2;
    host.runtimeProviderEpoch = 'new-provider-epoch';
    host.providerId = 'xora-relay';
    host.workspaceRoot = '/fixture';
    host.phase = 'ready';
    host.sidecarVersion = '0.2.102';
    host.models = [{ id: 'xora-relay', name: 'Relay' }];
    host.selectedModel = 'xora-relay';
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        update: (_id, patch) => (record = { ...record, ...patch }),
        list: () => [record]
    };
    host.providers = {
        selectedProviderId: () => 'xora-relay',
        runtimeEpoch: () => 'new-provider-epoch',
        get: id => ({ id, name: 'Relay', kind: 'custom', model: 'grok-4.5' }),
        preferredModelId: () => 'xora-relay'
    };
    host.security = { canonicalRoot: value => value };
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map([[record.acpSessionId, record.appSessionId]]);
    host.loadedSessionIds = new Set();
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.startRuntime = async () => { runtimeStarts += 1; };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            assert.notEqual(method, 'session/load');
            return { sessionId: 'acp-rebound' };
        }
    };
    host.acceptModelState = () => undefined;
    host.emit = event => emitted.push(event);
    host.emitSnapshot = () => undefined;

    const loaded = await host.loadSession(record.appSessionId);

    assert.equal(runtimeStarts, 0, 'the already-current runtime should be reused');
    assert.deepEqual(requests.map(request => request.method), ['session/new', 'session/set_model']);
    assert.equal(requests[0].params.cwd, '/fixture');
    assert.equal(JSON.stringify(requests[0].params).includes('old-provider-epoch'), false);
    assert.equal(loaded.status, 'idle');
    assert.equal(record.providerRuntimeEpoch, 'new-provider-epoch');
    assert.equal(record.acpSessionId, 'acp-rebound');
    assert.equal(host.activeSessionId, record.appSessionId);
    assert.equal(emitted.find(event => event.kind === 'session').session.status, 'idle');
});

test('session/new preserves the launch epoch when another window rotates the Provider while ACP is pending', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const newSessionGate = deferred();
    let currentEpoch = 'launch-epoch';
    let record;
    let loadRequests = 0;
    let defaultsRefreshes = 0;
    const provider = {
        id: 'grok-subscription',
        name: 'Grok 订阅',
        kind: 'grok-subscription'
    };

    // This is the same coherent callback shape used by startRuntime: the
    // environment, Provider profile and epoch are captured under one lock.
    const launchSnapshot = {
        environment: { FIXTURE_PROVIDER_KEY: 'redacted-fixture' },
        provider,
        runtimeEpoch: currentEpoch
    };
    host.runtimeProviderEpoch = launchSnapshot.runtimeEpoch;
    host.phase = 'ready';
    host.workspaceRoot = '/fixture';
    host.providerId = provider.id;
    host.models = [];
    host.selectedModel = undefined;
    host.sidecarVersion = '0.2.102';
    host.supportsAdditionalDirectories = false;
    host.sessionLoadGeneration = 0;
    host.security = { canonicalRoot: value => value };
    host.providers = {
        selectedProviderId: () => provider.id,
        runtimeEpoch: () => currentEpoch,
        get: id => id === provider.id ? provider : undefined,
        preferredModelId: () => undefined
    };
    host.acp = {
        request: (method, params) => {
            if (method === 'session/new') {
                assert.equal(params.cwd, '/fixture');
                return newSessionGate.promise;
            }
            if (method === 'session/load') loadRequests += 1;
            return Promise.resolve({});
        }
    };
    host.sessions = {
        create: input => (record = session('epoch-race', 'idle', {
            ...input,
            appSessionId: 'epoch-race',
            createdAt: '2026-07-21T00:00:00.000Z',
            updatedAt: '2026-07-21T00:00:00.000Z'
        })),
        get: id => id === record?.appSessionId ? record : undefined,
        list: () => record ? [record] : [],
        update: (_id, patch) => (record = { ...record, ...patch })
    };
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.acceptModelState = () => undefined;
    host.defaultModelId = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.notifyProviderDefaultsChanged = () => { defaultsRefreshes += 1; };

    const creating = host.createSession({
        workspaceRoot: '/fixture',
        providerId: provider.id,
        title: 'Epoch race'
    });
    await new Promise(resolve => setImmediate(resolve));

    // A different window updates the credential/endpoint while session/new is
    // in flight. The response belongs to the old process and old epoch.
    currentEpoch = 'rotated-by-peer';
    newSessionGate.resolve({ sessionId: 'acp-epoch-race' });
    const created = await creating;

    assert.equal(created.providerRuntimeEpoch, 'launch-epoch');
    assert.equal(created.status, 'read-only');
    assert.equal(record.providerRuntimeEpoch, 'launch-epoch');
    assert.equal(record.status, 'read-only');
    assert.equal(defaultsRefreshes, 1);
    assert.equal(host.activeSessionId, undefined);

    // The stale result is never activated. A later explicit continuation is
    // covered by the rebind tests below and must use session/new, not this id.
    assert.equal(loadRequests, 0);
});

test('startRuntime ready fast-path is valid only while the captured Provider epoch still matches', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let currentEpoch = 'ready-epoch';
    let stops = 0;
    let launchAttempts = 0;
    const provider = {
        id: 'grok-subscription',
        name: 'Grok 订阅',
        kind: 'grok-subscription'
    };
    host.disposed = false;
    host.workspaceRoot = '/fixture';
    host.attachedWorkspaceRoots = new Set(['/fixture']);
    host.security = { canonicalRoot: value => value };
    host.providers = {
        get: id => id === provider.id ? provider : undefined,
        selectedProviderId: () => provider.id,
        runtimeEpoch: () => currentEpoch,
        preferredModelId: () => undefined,
        mcpEnvironment: () => ({}),
        withProviderEnvironment: () => {
            launchAttempts += 1;
            throw new Error('fixture relaunch reached');
        }
    };
    host.providerId = provider.id;
    host.runtimeProviderEpoch = 'ready-epoch';
    host.phase = 'ready';
    host.acp = {};
    host.supervisor = {
        running: false,
        stop: async () => undefined
    };
    host.loadedSessionIds = new Set();
    host.runtimeGeneration = 1;
    host.currentSecrets = [];
    host.isWorkspaceTrusted = () => false;
    host.defaultModelId = () => undefined;
    host.emitSnapshot = () => undefined;
    host.snapshot = () => ({
        phase: host.phase,
        providerId: host.providerId,
        workspaceRoot: host.workspaceRoot
    });
    host.stopRuntimeLocked = async () => {
        stops += 1;
        host.acp = undefined;
        host.phase = 'stopped';
    };

    const fast = await host.startRuntimeLocked({
        workspaceRoot: '/fixture',
        providerId: provider.id
    });
    assert.equal(fast.phase, 'ready');
    assert.equal(stops, 0);
    assert.equal(launchAttempts, 0);

    host.phase = 'auth-required';
    const authRequired = await host.startRuntimeLocked({
        workspaceRoot: '/fixture',
        providerId: provider.id
    });
    assert.equal(authRequired.phase, 'auth-required');
    assert.equal(stops, 0);
    assert.equal(launchAttempts, 0);

    currentEpoch = 'rotated-epoch';
    await assert.rejects(
        host.startRuntimeLocked({ workspaceRoot: '/fixture', providerId: provider.id }),
        /fixture relaunch reached/
    );
    assert.equal(stops, 1);
    assert.equal(launchAttempts, 1);
    assert.equal(host.runtimeProviderEpoch, undefined);
});

test('opening history from an old Provider keeps the global Provider and attaches a fresh current ACP session', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session('old-provider-history', 'idle', {
        providerId: 'old-relay',
        providerRuntimeEpoch: 'old-relay-current-epoch',
        model: 'old-relay'
    });
    let runtimeStarts = 0;
    const acpRequests = [];
    const emitted = [];
    host.sessionLoadGeneration = 0;
    host.providerId = 'current-relay';
    host.selectedModel = 'current-relay';
    host.workspaceRoot = '/fixture';
    host.phase = 'ready';
    host.runtimeGeneration = 1;
    host.sidecarVersion = '0.2.102';
    host.runtimeProviderEpoch = 'current-relay-epoch';
    host.models = [{ id: 'current-relay', name: 'Current relay' }];
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (_id, patch) => (record = { ...record, ...patch })
    };
    host.providers = {
        selectedProviderId: () => 'current-relay',
        runtimeEpoch: providerId => providerId === 'old-relay'
            ? 'old-relay-current-epoch'
            : 'current-relay-epoch',
        get: id => ({ id, name: id, kind: 'custom', model: 'grok-4.5' }),
        preferredModelId: () => undefined,
        selectPreferredModel: () => undefined
    };
    host.security = { canonicalRoot: value => value };
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.restoringSessionCounts = new Map();
    host.startRuntime = async request => {
        runtimeStarts += 1;
        host.providerId = request.providerId;
        host.workspaceRoot = request.workspaceRoot;
        host.phase = 'ready';
    };
    host.acp = {
        request: async (method, params) => {
            acpRequests.push({ method, params });
            return { sessionId: 'acp-current-relay' };
        }
    };
    host.acceptModelState = () => undefined;
    host.emit = event => emitted.push(event);
    host.emitSnapshot = () => undefined;

    const loaded = await host.loadSession(record.appSessionId);

    assert.equal(loaded.status, 'idle');
    assert.equal(record.status, 'idle');
    assert.equal(record.providerId, 'current-relay');
    assert.equal(record.providerRuntimeEpoch, 'current-relay-epoch');
    assert.equal(record.acpSessionId, 'acp-current-relay');
    assert.equal(host.providerId, 'current-relay');
    assert.equal(host.selectedModel, 'current-relay');
    assert.equal(runtimeStarts, 0);
    assert.deepEqual(acpRequests.map(request => request.method), ['session/new', 'session/set_model']);
    assert.equal(acpRequests[0].params._meta.modelId, 'current-relay');
    assert.equal(JSON.stringify(acpRequests[0].params).includes('acp-old-provider-history'), false);
    assert.equal(emitted.find(event => event.kind === 'session').session.appSessionId, record.appSessionId);
});

test('restoring same-Provider history uses the current global model instead of the historical model', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session('same-provider-history', 'idle', {
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'subscription-epoch',
        model: 'historical-model',
        reasoningEffort: 'xhigh'
    });
    const requests = [];
    host.sessionLoadGeneration = 0;
    host.runtimeGeneration = 3;
    host.providerId = 'grok-subscription';
    host.selectedModel = 'current-global-model';
    host.workspaceRoot = '/fixture';
    host.phase = 'ready';
    host.sidecarVersion = '0.2.102';
    host.runtimeProviderEpoch = 'subscription-epoch';
    host.models = [
        { id: 'historical-model', name: 'Historical model' },
        {
            id: 'current-global-model',
            name: 'Current global model',
            reasoningOptions: [
                { id: 'quick', value: 'low', name: 'Quick', default: true },
                { id: 'deep', value: 'xhigh', name: 'Deep' }
            ]
        }
    ];
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (_id, patch) => (record = { ...record, ...patch })
    };
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        get: id => ({ id, name: 'Grok 订阅', kind: 'grok-subscription' }),
        preferredModelId: () => 'current-global-model',
        selectPreferredModel: () => undefined
    };
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.restoringSessionCounts = new Map();
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.acceptModelState = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            return {};
        }
    };

    const loaded = await host.loadSession(record.appSessionId);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'session/load');
    assert.equal(requests[0].params._meta.modelId, 'current-global-model');
    assert.deepEqual(requests[1], {
        method: 'session/set_model',
        params: {
            sessionId: record.acpSessionId,
            modelId: 'current-global-model',
            _meta: { reasoningEffort: 'xhigh' }
        }
    });
    assert.equal(loaded.model, 'current-global-model');
    assert.equal(record.model, 'current-global-model');
    assert.equal(record.reasoningEffort, 'xhigh');
    assert.equal(host.selectedModel, 'current-global-model');
});

test('legacy read-only history becomes live through session/new and never retries the retired ACP id', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = session('retired', 'read-only', {
        providerId: 'xora-relay',
        providerRuntimeEpoch: 'retired-epoch'
    });
    const requests = [];
    host.sessionLoadGeneration = 0;
    host.runtimeGeneration = 1;
    host.runtimeProviderEpoch = 'current-epoch';
    host.providerId = 'xora-relay';
    host.workspaceRoot = '/fixture';
    host.phase = 'ready';
    host.sidecarVersion = '0.2.102';
    host.models = [{ id: 'xora-relay', name: 'Relay' }];
    host.sessions = {
        get: () => record,
        update: (_id, patch) => (record = { ...record, ...patch }),
        list: () => [record]
    };
    host.providers = {
        selectedProviderId: () => 'xora-relay',
        runtimeEpoch: () => 'current-epoch',
        get: id => ({ id, name: 'Relay', kind: 'custom', model: 'grok-4.5' }),
        preferredModelId: () => 'xora-relay'
    };
    host.security = { canonicalRoot: value => value };
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map([[record.acpSessionId, record.appSessionId]]);
    host.loadedSessionIds = new Set();
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.acceptModelState = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            return { sessionId: 'acp-live-again' };
        }
    };

    const loaded = await host.loadSession(record.appSessionId);

    assert.equal(loaded.status, 'idle');
    assert.equal(loaded.acpSessionId, 'acp-live-again');
    assert.deepEqual(requests.map(request => request.method), ['session/new', 'session/set_model']);
    assert.equal(JSON.stringify(requests[0].params).includes('acp-retired'), false);
});

test('deleting a Provider invalidates a matching peer and switches it to the persisted fallback', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    host.lifecycleTail = Promise.resolve();
    host.providerId = 'xora-deleted';
    host.phase = 'stopped';
    host.supervisor = { running: false };
    host.acp = undefined;
    host.managementChild = undefined;
    host.activeSessionId = 'old-session';
    host.loadedSessionIds = new Set(['old-session']);
    host.sessionLoadGeneration = 2;
    host.models = [{ id: 'xora-deleted', name: 'Deleted' }];
    host.sessions = { markProviderSessionsReadOnly: () => [], list: () => [] };
    host.providers = {
        subscriptionAuthStatus: () => 'unknown',
        selectedProviderId: () => 'grok-subscription',
        get: id => id === 'grok-subscription'
            ? { id, name: 'Grok 订阅', kind: 'grok-subscription' }
            : undefined,
        preferredModelId: () => undefined
    };
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };

    host.notifyProviderRuntimeInvalidated({
        providerId: 'xora-deleted',
        reason: 'provider-deleted',
        invalidateSession: true
    });
    await host.lifecycleTail;

    assert.equal(host.providerId, 'grok-subscription');
    assert.equal(host.activeSessionId, undefined);
    assert.deepEqual(host.models, []);
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
        },
        selectDefaultModel: async () => undefined
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;

    await widget.loadModelOptions();
    await widget.selectModel(undefined, 'grok-fixture');

    assert.deepEqual(timeline, ['start', 'refresh']);
    assert.equal(widget.modelOptionsLoading, false);
    assert.equal(widget.newSessionModel, 'grok-fixture');
});

test('a Provider metadata revision hot-reloads the same custom model without letting an older read win', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const staleRead = deferred();
    const oldProfiles = [{
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        secretRef: 'provider:xora-relay',
        credentialConfigured: true
    }];
    const newProfiles = [{ ...oldProfiles[0], model: 'grok-4.6' }];
    let reads = 0;

    widget.providerRefreshTail = Promise.resolve();
    widget.providers = oldProfiles;
    widget.observedProviderProfilesRevision = 1;
    widget.model = {
        snapshot: {
            providerId: 'xora-relay',
            providerProfilesRevision: 1,
            models: [{ id: 'xora-relay', name: 'xora-relay' }],
            selectedModel: 'xora-relay',
            sessions: [],
            permissionMode: 'request-approval'
        }
    };
    widget.service = {
        listProviders: async () => {
            reads += 1;
            if (reads === 1) {
                await staleRead.promise;
                return oldProfiles;
            }
            return newProfiles;
        }
    };
    widget.requestRuntimePrewarm = () => undefined;
    widget.update = () => undefined;
    widget.showInlineNotice = error => assert.fail(error);

    const firstRefresh = widget.refreshProviders();
    widget.model.snapshot.providerProfilesRevision = 2;
    assert.equal(widget.reconcileProviderProfiles(), true);
    staleRead.resolve();
    await firstRefresh;
    await widget.providerRefreshTail;

    const groups = agentModelChoiceGroups(widget.providers, widget.model.snapshot);
    assert.equal(reads, 2);
    assert.equal(groups[0].choices[0].label, 'grok-4.6');
    assert.equal(groups[0].choices[0].modelId, 'xora-relay', 'ACP keeps the credential-safe local alias');
    assert.equal(widget.reconcileProviderProfiles(), false, 'ordinary snapshots at the same revision do not reread metadata');
});

test('a stale cross-Provider model event is ignored because service switching belongs to Settings', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    widget.modelOptionsLoading = false;
    widget.sessionLoading = false;
    widget.submission = undefined;
    widget.providers = [
        {
            id: 'xai-api-key',
            name: 'xAI / Grok API',
            kind: 'xai-api-key',
            protocol: 'openai-responses',
            model: 'grok-4.5',
            secretRef: 'provider:xai-api-key',
            credentialConfigured: true
        },
        {
            id: 'xora-relay',
            name: '横迪AI',
            kind: 'custom',
            protocol: 'openai-responses',
            baseUrl: 'https://relay.example.invalid/v1',
            model: 'grok-4.5',
            secretRef: 'provider:xora-relay',
            credentialConfigured: true
        }
    ];
    widget.model = {
        snapshot: {
            phase: 'ready',
            workspaceRoot: '/fixture',
            workspaceAttached: true,
            workspaceTrusted: true,
            providerId: 'xai-api-key',
            models: [{ id: 'xora-xai-api', name: 'xAI / Grok API' }],
            sessions: [],
            permissionMode: 'request-approval'
        },
        refresh: async () => timeline.push('refresh-snapshot')
    };
    widget.service = {
        selectProvider: async providerId => timeline.push(`select-provider:${providerId}`),
        selectDefaultModel: async () => timeline.push('unexpected-default-model')
    };
    widget.refreshProviders = async () => timeline.push('refresh-providers');
    widget.resetToNewSession = () => timeline.push('reset-session');
    widget.requestRuntimePrewarm = () => timeline.push('prewarm');
    widget.messages = {
        info: message => timeline.push(`info:${message}`),
        error: message => timeline.push(`error:${message}`)
    };
    widget.update = () => undefined;

    await widget.selectModel(undefined, encodeAgentModelChoice('xora-relay', 'xora-relay'));

    assert.deepEqual(timeline, ['refresh-snapshot']);
    assert.match(widget.inlineNotice.message, /模型服务已变化/);
    assert.equal(widget.newSessionModel, undefined);
    assert.equal(widget.modelOptionsLoading, false);
});

test('model selection waits for the visible old-Provider history to rebind and shares the hydration flight', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const restore = deferred();
    const timeline = [];
    const historical = session('old-history', 'idle', { providerId: 'old-relay', model: 'old-relay' });
    const rebound = { ...historical, providerId: 'grok-subscription', model: 'grok-4.6' };

    widget.sessionLoading = false;
    widget.modelSelectionLoading = false;
    widget.hasPromptLaneWork = () => false;
    widget.agentContextKey = () => 'current-provider-history';
    widget.sameWorkspaceRoot = (left, right) => left === right;
    widget.ensureSessionHydrated = async () => {
        timeline.push('hydrate');
        return restore.promise;
    };
    widget.model = {
        snapshot: {
            phase: 'ready',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            activeSessionId: historical.appSessionId,
            selectedModel: 'grok-build',
            models: [{ id: 'grok-build' }, { id: 'grok-4.6' }],
            sessions: [historical]
        },
        updateSession: loaded => {
            timeline.push(`session:${loaded.providerId}`);
            widget.model.snapshot.sessions = [loaded];
        },
        refresh: async () => timeline.push('refresh')
    };
    widget.service = {
        selectModel: async (sessionId, modelId) => timeline.push(`select:${sessionId}:${modelId}`)
    };
    widget.update = () => undefined;

    const switching = widget.selectModel(
        historical,
        encodeAgentModelChoice('grok-subscription', 'grok-4.6')
    );
    await Promise.resolve();
    assert.equal(widget.modelSelectionLoading, true);
    assert.deepEqual(timeline, ['hydrate']);

    // A second click while the first selector action is waiting must neither
    // start another hydration nor race another session/set_model request.
    await widget.selectModel(
        historical,
        encodeAgentModelChoice('grok-subscription', 'grok-build')
    );
    assert.deepEqual(timeline, ['hydrate']);

    restore.resolve(rebound);
    await switching;

    assert.deepEqual(timeline, [
        'hydrate',
        'session:grok-subscription',
        'select:old-history:grok-4.6',
        'refresh'
    ]);
    assert.equal(widget.modelSelectionLoading, false);
});

test('reasoning selection waits for current-Provider hydration without blocking the composer', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const restore = deferred();
    const timeline = [];
    const historical = session('reasoning-history', 'idle', { providerId: 'old-relay' });
    const rebound = { ...historical, providerId: 'grok-subscription', model: 'grok-4.6' };

    widget.sessionLoading = false;
    widget.modelSelectionLoading = false;
    widget.hasPromptLaneWork = () => false;
    widget.agentContextKey = () => 'reasoning-history-key';
    widget.sameWorkspaceRoot = (left, right) => left === right;
    widget.ensureSessionHydrated = async () => restore.promise;
    widget.model = {
        snapshot: {
            phase: 'ready',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            activeSessionId: historical.appSessionId,
            sessions: [historical]
        },
        updateSession: loaded => timeline.push(`session:${loaded.providerId}`),
        refresh: async () => timeline.push('refresh')
    };
    widget.service = {
        selectReasoningEffort: async (sessionId, effort) => timeline.push(`reasoning:${sessionId}:${effort}`)
    };
    widget.update = () => undefined;

    const switching = widget.selectReasoningEffort(historical, 'deep', [
        { id: 'deep', value: 'xhigh', name: 'Deep' }
    ]);
    await Promise.resolve();
    assert.equal(widget.modelSelectionLoading, true);
    assert.equal(widget.sessionLoading, false, 'only model controls become busy; drafting stays available');
    restore.resolve(rebound);
    await switching;

    assert.deepEqual(timeline, [
        'session:grok-subscription',
        'reasoning:reasoning-history:xhigh',
        'refresh'
    ]);
    assert.equal(widget.modelSelectionLoading, false);
});

test('one model menu atomically applies the selected model and its nested reasoning level', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    const active = session('combined-model-choice', 'idle', { model: 'grok-build' });

    widget.sessionLoading = false;
    widget.modelSelectionLoading = false;
    widget.hasPromptLaneWork = () => false;
    widget.agentContextKey = () => 'combined-model-key';
    widget.sameWorkspaceRoot = (left, right) => left === right;
    widget.ensureSessionHydrated = async () => active;
    widget.model = {
        snapshot: {
            phase: 'ready',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            activeSessionId: active.appSessionId,
            selectedModel: 'grok-build',
            models: [{
                id: 'grok-4.6',
                name: 'Grok 4.6',
                reasoningOptions: [
                    { id: 'high', value: 'high', name: 'High' },
                    { id: 'deep', value: 'xhigh', name: 'Deep' }
                ]
            }],
            sessions: [active]
        },
        updateSession: () => timeline.push('session'),
        refresh: async () => timeline.push('refresh')
    };
    widget.service = {
        selectModel: async (sessionId, modelId, effort) => timeline.push(`model:${sessionId}:${modelId}:${effort}`)
    };
    widget.update = () => undefined;

    await widget.selectModelConfiguration(active, encodeAgentModelConfiguration(
        encodeAgentModelChoice('grok-subscription', 'grok-4.6'),
        'xhigh'
    ));

    assert.deepEqual(timeline, [
        'session',
        'model:combined-model-choice:grok-4.6:xhigh',
        'refresh'
    ]);
    assert.equal(widget.modelSelectionLoading, false);
});

test('auth-required to ready resumes visible history hydration exactly once', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    let hydrations = 0;
    widget.observedRuntimePhase = 'auth-required';
    widget.model = { snapshot: { phase: 'ready' } };
    widget.hydrateActiveSessionInBackground = async () => { hydrations += 1; };

    widget.reconcileRuntimePrewarmState();
    widget.reconcileRuntimePrewarmState();

    assert.equal(hydrations, 1);
    assert.equal(widget.observedRuntimePhase, 'ready');
});

test('a failed default-model write rolls the optimistic new-session selector back', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    widget.sessionLoading = false;
    widget.newSessionModel = 'grok-old';
    widget.model = {
        snapshot: { providerId: 'grok-subscription', selectedModel: 'grok-old' },
        refresh: async () => undefined
    };
    widget.service = {
        selectDefaultModel: async () => { throw new Error('fixture lock'); }
    };
    widget.messages = { error: () => undefined };
    widget.update = () => undefined;

    await widget.selectModel(undefined, encodeAgentModelChoice('grok-subscription', 'grok-new'));

    assert.equal(widget.newSessionModel, 'grok-old');
});

test('a stale Provider-default DOM choice is consumed locally and never persisted as an ACP model', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    widget.sessionLoading = false;
    widget.model = {
        snapshot: {
            providerId: 'grok-subscription',
            selectedModel: 'grok-runtime-default'
        }
    };
    widget.service = {
        selectDefaultModel: async () => timeline.push('unexpected-default-model'),
        selectProvider: async () => timeline.push('unexpected-provider-switch')
    };
    widget.requestRuntimePrewarm = () => timeline.push('prewarm');
    widget.update = () => timeline.push('update');

    await widget.selectModel(undefined, encodeAgentModelChoice(
        'grok-subscription',
        PROVIDER_DEFAULT_MODEL_CHOICE_ID
    ));

    assert.deepEqual(timeline, ['prewarm', 'update']);
    assert.equal(widget.newSessionModel, 'grok-runtime-default');
});

test('Electron backend rejects the renderer Provider-default choice even before ACP advertises models', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    host.providerId = 'grok-subscription';
    host.activePrompts = new Map();
    host.models = [];

    await assert.rejects(
        host.selectDefaultModel('grok-subscription', PROVIDER_DEFAULT_MODEL_CHOICE_ID),
        /internal Provider default choice/
    );
});

test('Electron backend rejects catalog aliases owned by another or retired Provider', async () => {
    const relay = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        secretRef: 'provider:xora-relay'
    };
    const other = { ...relay, id: 'xora-other', name: 'Other', secretRef: 'provider:xora-other' };
    const subscription = { id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription' };
    const host = Object.create(GrokAgentHostService.prototype);
    host.lifecycleTail = Promise.resolve();
    host.activePrompts = new Map();
    host.providerId = relay.id;
    host.models = [
        { id: relay.id, name: relay.name },
        { id: other.id, name: other.name },
        { id: 'xora-xai-api', name: 'xAI / Grok API' }
    ];
    host.providers = {
        selectedProviderId: () => host.providerId,
        get: id => [relay, other, subscription].find(provider => provider.id === id),
        list: () => [subscription, relay, other],
        selectPreferredModel: () => assert.fail('foreign aliases must not be persisted')
    };

    await assert.rejects(
        host.selectDefaultModel(relay.id, other.id),
        /不属于当前模型服务/
    );
    await assert.rejects(
        host.selectDefaultModel(relay.id, 'xora-xai-api'),
        /不属于当前模型服务/
    );
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
            sessions: [session('session-a')],
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
    await widget.hydrateActiveSessionInBackground();

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

test('the first send reuses a ready prewarm and creates a session without redundant runtime or history RPCs', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    const prior = session('prior', 'completed', { workspaceRoot: '/fixture' });
    const created = session('created', 'idle', { workspaceRoot: '/fixture' });
    const snapshot = runtimeSnapshot('/fixture', [prior], undefined);
    const refreshed = deferred();

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
        refresh: async () => {
            timeline.push('refresh');
            await refreshed.promise;
        },
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
        startRuntime: async request => {
            timeline.push(`runtime:${request.workspaceRoot}:${request.providerId}`);
            return snapshot;
        },
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

    const sending = widget.send();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(timeline, ['refresh', 'save-all'],
        'Save All and the authoritative Provider refresh should overlap');
    assert.equal(widget.sendPreparationPreview.text, 'inspect this project',
        'the clicked task should be visible before the Provider refresh resolves');
    refreshed.resolve();
    await sending;

    assert.deepEqual(timeline, [
        'refresh',
        'save-all',
        'session/new',
        'session/prompt:created'
    ]);
    assert.equal(snapshot.activeSessionId, 'created');
    assert.equal(snapshot.sessions.some(candidate => candidate.appSessionId === 'prior'), true);
    assert.equal(widget.sendPreparationPreview, undefined);
});

test('a typed missing session before ACP admission is rebound once to a fresh conversation', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const ghost = session('ghost', 'idle', { workspaceRoot: '/fixture' });
    const replacement = session('replacement', 'idle', { workspaceRoot: '/fixture' });
    const snapshot = runtimeSnapshot('/fixture', [ghost], ghost.appSessionId);
    const prompts = [];
    let creates = 0;

    widget.prompt = '保留并发送这条任务';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.openSessionTabs = [ghost.appSessionId];
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.followTranscript = () => undefined;
    widget.model = {
        snapshot,
        forgetMissingSession: id => {
            snapshot.sessions = snapshot.sessions.filter(candidate => candidate.appSessionId !== id);
            snapshot.activeSessionId = undefined;
        },
        startNewSession: () => { snapshot.activeSessionId = undefined; },
        setSession: selected => {
            snapshot.sessions.unshift(selected);
            snapshot.activeSessionId = selected.appSessionId;
        },
        updateSession: selected => snapshot.sessions.unshift(selected)
    };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        createSession: async () => {
            creates += 1;
            return replacement;
        },
        sendPrompt: async request => {
            prompts.push(request.sessionId);
            if (request.sessionId === ghost.appSessionId) {
                const error = new Error('SESSION_NOT_FOUND: Unknown Xora Code session.');
                error.code = 'SESSION_NOT_FOUND';
                throw error;
            }
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;
    widget.hydratedSessionKeyState().add(widget.agentContextKey(
        snapshot.workspaceRoot,
        snapshot.providerId,
        ghost.appSessionId
    ));

    await widget.send();

    assert.deepEqual(prompts, [ghost.appSessionId, replacement.appSessionId]);
    assert.equal(creates, 1);
    assert.equal(snapshot.activeSessionId, replacement.appSessionId);
    assert.equal(snapshot.sessions.some(candidate => candidate.appSessionId === ghost.appSessionId), false);
    assert.equal(widget.openSessionTabs.includes(ghost.appSessionId), false);
    assert.equal(widget.currentPromptLane(false).retryable, undefined);
});

test('a missing-session error after the user event never replays an admitted task', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const active = session('active', 'idle', { workspaceRoot: '/fixture' });
    const snapshot = runtimeSnapshot('/fixture', [active], active.appSessionId);
    const prompts = [];
    let creates = 0;

    widget.prompt = '只能发送一次';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.followTranscript = () => undefined;
    widget.model = { snapshot };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        createSession: async () => {
            creates += 1;
            return session('must-not-create');
        },
        sendPrompt: async request => {
            prompts.push(request.sessionId);
            widget.acceptAgentEvent({
                kind: 'text-delta',
                sessionId: request.sessionId,
                role: 'user',
                text: request.text
            });
            const error = new Error('SESSION_NOT_FOUND: Unknown Xora Code session.');
            error.code = 'SESSION_NOT_FOUND';
            throw error;
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.showInlineNotice = () => undefined;
    widget.update = () => undefined;
    widget.hydratedSessionKeyState().add(widget.agentContextKey(
        snapshot.workspaceRoot,
        snapshot.providerId,
        active.appSessionId
    ));

    await widget.send();

    assert.deepEqual(prompts, [active.appSessionId]);
    assert.equal(creates, 0);
    assert.equal(widget.currentPromptLane(false).retryable.text, '只能发送一次');
});

test('an untyped legacy unknown-session rejection cannot replay after prompt RPC starts', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const active = session('active');
    const snapshot = runtimeSnapshot('/fixture', [active], active.appSessionId);
    let creates = 0;
    let prompts = 0;
    widget.prompt = '不得重复';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.followTranscript = () => undefined;
    widget.model = { snapshot };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        createSession: async () => {
            creates += 1;
            return session('must-not-create');
        },
        sendPrompt: async () => {
            prompts += 1;
            // Deliberately reject before the event channel publishes the user
            // message, reproducing the dangerous cross-channel ordering.
            throw new Error('Unknown session: remote-acp-id');
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.showInlineNotice = () => undefined;
    widget.update = () => undefined;
    widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', snapshot.providerId, active.appSessionId));

    await widget.send();

    assert.equal(prompts, 1);
    assert.equal(creates, 0);
    assert.equal(widget.currentPromptLane(false).retryable.text, '不得重复');
});

test('a remote ACP unknown-session error before prompt admission never tombstones local history', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const active = session('active');
    const snapshot = runtimeSnapshot('/fixture', [active], active.appSessionId);
    let forgotten = 0;
    widget.model = {
        snapshot,
        forgetMissingSession: () => { forgotten += 1; }
    };
    widget.roots = ['/fixture'];
    const submission = {
        id: 'remote-unknown',
        text: '保留历史',
        contextKey: 'active',
        generation: 0,
        workspaceRoot: '/fixture',
        providerId: snapshot.providerId,
        taskMode: 'standard',
        executionMode: 'standard',
        acceptedAt: Date.now(),
        sourceSessionId: active.appSessionId,
        sessionId: active.appSessionId,
        attachments: [],
        state: 'preparing',
        promptRequestStarted: false
    };
    const lane = {
        key: widget.promptLaneKey('/fixture', snapshot.providerId, active.appSessionId),
        workspaceRoot: '/fixture',
        providerId: snapshot.providerId,
        sourceSessionId: active.appSessionId,
        sessionId: active.appSessionId,
        queue: [],
        active: submission
    };

    assert.equal(widget.recoverMissingSessionBeforeAdmission(
        lane,
        submission,
        new Error('Unknown session: remote-acp-id')
    ), false);
    assert.equal(forgotten, 0);
    assert.equal(snapshot.sessions.some(candidate => candidate.appSessionId === active.appSessionId), true);
});

test('recovering a background ghost never steals the visible new-conversation draft lane', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const ghost = session('ghost');
    const snapshot = runtimeSnapshot('/fixture', [ghost], undefined);
    widget.model = {
        snapshot,
        forgetMissingSession: id => {
            snapshot.sessions = snapshot.sessions.filter(candidate => candidate.appSessionId !== id);
        }
    };
    widget.roots = ['/fixture'];
    widget.newSessionLaneSequence = 4;
    widget.activeComposerLaneKey = widget.promptLaneKey('/fixture', snapshot.providerId, undefined);
    widget.observedAgentContextKey = widget.activeComposerLaneKey;
    const visibleKey = widget.activeComposerLaneKey;
    const submission = {
        id: 'background-prompt',
        text: '后台任务',
        contextKey: 'old',
        generation: 0,
        workspaceRoot: '/fixture',
        providerId: snapshot.providerId,
        taskMode: 'standard',
        executionMode: 'standard',
        acceptedAt: Date.now(),
        sourceSessionId: ghost.appSessionId,
        sessionId: ghost.appSessionId,
        attachments: [],
        state: 'preparing'
    };
    const lane = {
        key: widget.promptLaneKey('/fixture', snapshot.providerId, ghost.appSessionId),
        workspaceRoot: '/fixture',
        providerId: snapshot.providerId,
        sourceSessionId: ghost.appSessionId,
        sessionId: ghost.appSessionId,
        queue: [],
        active: submission
    };
    widget.promptLaneState().set(lane.key, lane);

    const recovered = widget.recoverMissingSessionBeforeAdmission(
        lane,
        submission,
        new Error('SESSION_NOT_FOUND: Unknown Xora Code session.')
    );

    assert.equal(recovered, true);
    assert.equal(widget.activeComposerLaneKey, visibleKey);
    assert.equal(widget.newSessionLaneSequence, 4);
    assert.match(lane.key, /recovery-background-prompt$/);
});

test('composer text and images are restored independently for each conversation', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const a = session('a');
    const b = session('b');
    const snapshot = runtimeSnapshot('/fixture', [a, b], a.appSessionId);
    const imageA = { id: 'image-a', mimeType: 'image/png', data: 'YQ==', byteSize: 1, previewUrl: 'blob:a' };
    const imageB = { id: 'image-b', mimeType: 'image/png', data: 'Yg==', byteSize: 1, previewUrl: 'blob:b' };

    widget.model = { snapshot };
    widget.roots = ['/fixture'];
    widget.prompt = 'A 会话草稿';
    widget.draftImages = [imageA];
    widget.imageReadGeneration = 0;
    widget.imageReadsInFlight = 0;
    widget.pendingImageBytes = 0;
    widget.imageAnnouncement = '';
    widget.closeSlashMenu = () => undefined;
    widget.textarea = null;
    widget.activeComposerLaneKey = widget.promptLaneKey('/fixture', snapshot.providerId, a.appSessionId);
    widget.storeActiveComposerDraft();

    snapshot.activeSessionId = b.appSessionId;
    const bKey = widget.promptLaneKey('/fixture', snapshot.providerId, b.appSessionId);
    widget.activateComposerLane(bKey);
    widget.prompt = 'B 会话草稿';
    widget.draftImages = [imageB];
    widget.storeActiveComposerDraft();

    snapshot.activeSessionId = a.appSessionId;
    widget.activateComposerLane(widget.promptLaneKey('/fixture', snapshot.providerId, a.appSessionId));
    assert.equal(widget.prompt, 'A 会话草稿');
    assert.deepEqual(widget.draftImages.map(image => image.id), ['image-a']);

    snapshot.activeSessionId = b.appSessionId;
    widget.activateComposerLane(bKey);
    assert.equal(widget.prompt, 'B 会话草稿');
    assert.deepEqual(widget.draftImages.map(image => image.id), ['image-b']);
});

test('one conversation sends queued prompts in FIFO order and can cancel one queued item', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const active = session('active');
    const snapshot = runtimeSnapshot('/fixture', [active], active.appSessionId);
    const firstGate = deferred();
    const calls = [];

    widget.prompt = '第一条';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.model = { snapshot };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        sendPrompt: async request => {
            calls.push(request.text);
            if (request.text === '第一条') await firstGate.promise;
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;
    widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', snapshot.providerId, active.appSessionId));

    const first = widget.send();
    widget.prompt = '第二条（取消）';
    const second = widget.send();
    widget.prompt = '第三条';
    const third = widget.send();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, ['第一条']);
    const lane = widget.currentPromptLane(false);
    assert.deepEqual(lane.queue.map(item => item.text), ['第二条（取消）', '第三条']);
    await widget.cancelPromptItem(lane.queue[0].id);
    await second;
    assert.deepEqual(lane.queue.map(item => item.text), ['第三条']);

    firstGate.resolve();
    await Promise.all([first, third]);
    assert.deepEqual(calls, ['第一条', '第三条']);
});

test('a queued prompt can guide the running turn without becoming a second session prompt', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const active = session('active');
    const snapshot = runtimeSnapshot('/fixture', [active], active.appSessionId);
    const firstGate = deferred();
    const prompts = [];
    const guidance = [];

    widget.prompt = '先分析当前实现';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.model = { snapshot };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.followTranscript = () => undefined;
    widget.service = {
        sendPrompt: async request => {
            prompts.push(request.text);
            if (request.text === '先分析当前实现') await firstGate.promise;
        },
        guidePrompt: async request => {
            guidance.push(request);
            return { status: 'accepted', interjectionId: 'guide-1' };
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;
    widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', snapshot.providerId, active.appSessionId));

    const first = widget.send();
    widget.prompt = '不要重构，先补测试';
    const queued = widget.send();
    await new Promise(resolve => setImmediate(resolve));

    const lane = widget.currentPromptLane(false);
    assert.equal(lane.active.text, '先分析当前实现');
    assert.deepEqual(lane.queue.map(item => item.text), ['不要重构，先补测试']);
    await widget.guidePromptItem(lane.queue[0].id);
    await queued;

    assert.deepEqual(prompts, ['先分析当前实现']);
    assert.deepEqual(guidance, [{
        sessionId: active.appSessionId,
        text: '不要重构，先补测试',
        attachments: []
    }]);
    assert.deepEqual(lane.queue, []);

    firstGate.resolve();
    await first;
});

test('a guidance admission race leaves the message in FIFO order', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const active = session('active');
    const snapshot = runtimeSnapshot('/fixture', [active], active.appSessionId);
    const firstGate = deferred();
    const prompts = [];
    const notices = [];

    widget.prompt = '第一条';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.model = { snapshot };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.showInlineNotice = message => notices.push(message);
    widget.service = {
        sendPrompt: async request => {
            prompts.push(request.text);
            if (request.text === '第一条') await firstGate.promise;
        },
        guidePrompt: async () => ({ status: 'not-running' })
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;
    widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', snapshot.providerId, active.appSessionId));

    const first = widget.send();
    widget.prompt = '仍按队列发送';
    const second = widget.send();
    await new Promise(resolve => setImmediate(resolve));
    const lane = widget.currentPromptLane(false);
    await widget.guidePromptItem(lane.queue[0].id);
    assert.deepEqual(lane.queue.map(item => item.text), ['仍按队列发送']);
    assert.match(notices[0], /继续按队列发送/);

    firstGate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(prompts, ['第一条', '仍按队列发送']);
});

test('different conversations can send concurrently without sharing a preparation state', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const a = session('a');
    const b = session('b');
    const snapshot = runtimeSnapshot('/fixture', [a, b], a.appSessionId);
    const gates = { A: deferred(), B: deferred() };
    const calls = [];

    widget.prompt = 'A';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.closeSlashMenu = () => undefined;
    widget.model = { snapshot };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        sendPrompt: async request => {
            calls.push(`${request.sessionId}:${request.text}`);
            await gates[request.text].promise;
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;
    for (const current of [a, b]) {
        widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', snapshot.providerId, current.appSessionId));
    }

    const sendingA = widget.send();
    await new Promise(resolve => setImmediate(resolve));
    snapshot.activeSessionId = b.appSessionId;
    widget.activateComposerLane(widget.promptLaneKey('/fixture', snapshot.providerId, b.appSessionId));
    widget.prompt = 'B';
    const sendingB = widget.send();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, ['a:A', 'b:B']);
    assert.equal(widget.currentPromptLane(false).active.text, 'B');
    assert.equal(widget.submission.text, 'B', 'visible preparation mirrors only the selected conversation');

    gates.A.resolve();
    gates.B.resolve();
    await Promise.all([sendingA, sendingB]);
});

test('a running conversation does not lock another continuous-mode choice or reset its captured mode', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const modes = [
        { id: 'default', name: 'Agent' },
        { id: 'plan', name: 'Plan' }
    ];
    const a = session('a', 'running', { currentModeId: 'default', availableModes: modes });
    const b = session('b', 'idle', {
        currentModeId: 'default',
        availableModes: modes,
        goalCapability: { available: true, command: true, updateTool: true }
    });
    const snapshot = runtimeSnapshot('/fixture', [a, b], a.appSessionId);
    const gates = { A: deferred(), B: deferred() };
    const prompts = [];
    const modeChanges = [];

    widget.prompt = 'A';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.imageReadGeneration = 0;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: snapshot.providerId, name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.closeSlashMenu = () => undefined;
    widget.requestRuntimePrewarm = () => undefined;
    widget.model = {
        snapshot,
        updateSession: updated => {
            const index = snapshot.sessions.findIndex(candidate => candidate.appSessionId === updated.appSessionId);
            snapshot.sessions[index] = updated;
        }
    };
    widget.commandService = { executeCommand: async () => undefined };
    widget.workspaceRoot = async () => '/fixture';
    widget.service = {
        setSessionMode: async (sessionId, modeId) => {
            modeChanges.push(`${sessionId}:${modeId}`);
            const current = snapshot.sessions.find(candidate => candidate.appSessionId === sessionId);
            return { ...current, currentModeId: modeId };
        },
        sendPrompt: async request => {
            prompts.push(request);
            await gates[request.text].promise;
        }
    };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;
    for (const current of [a, b]) {
        widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', snapshot.providerId, current.appSessionId));
    }

    const sendingA = widget.send();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(widget.hasPromptLaneWork(), true, 'A keeps application-wide settings locked');

    snapshot.activeSessionId = b.appSessionId;
    widget.activateComposerLane(widget.promptLaneKey('/fixture', snapshot.providerId, b.appSessionId));
    assert.equal(widget.currentComposerHasPromptLaneWork(), false, 'B owns an independent task-mode lane');
    widget.selectComposerTaskMode('continuous');
    assert.equal(widget.currentComposerTaskMode(), 'continuous');
    widget.prompt = 'B';
    const sendingB = widget.send();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(modeChanges, []);
    assert.deepEqual(prompts.map(request => [request.sessionId, request.text, request.executionMode]), [
        ['a', 'A', 'standard'],
        ['b', 'B', 'continuous']
    ]);
    assert.equal(widget.currentComposerTaskMode(), 'continuous',
        'continuous completion remains the conversation preference while its task is running');
    assert.equal(widget.composerTaskModeState().get(widget.promptLaneKey('/fixture', snapshot.providerId, a.appSessionId)), undefined,
        'B mode selection must not rewrite A');

    gates.A.resolve();
    gates.B.resolve();
    await Promise.all([sendingA, sendingB]);
});

test('the session rename widget preserves a Chinese IME candidate until composition has fully ended', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    let guardTimer;
    let commits = 0;
    let prevented = 0;
    let stopped = 0;
    const originalSetTimeout = global.window.setTimeout;
    const originalClearTimeout = global.window.clearTimeout;
    global.window.setTimeout = callback => {
        guardTimer = callback;
        return 42;
    };
    global.window.clearTimeout = () => { guardTimer = undefined; };
    try {
        widget.renameDraft = '';
        widget.renameImeComposing = true;
        widget.renameImeCompositionJustEnded = false;
        widget.renameImeCompositionGuardTimer = undefined;
        widget.commitSessionRename = () => { commits += 1; };
        const event = (isComposing, keyCode) => ({
            key: 'Enter',
            nativeEvent: { isComposing, keyCode },
            preventDefault: () => { prevented += 1; },
            stopPropagation: () => { stopped += 1; }
        });

        widget.handleSessionRenameKeyDown(event(true, 229), 'active');
        assert.equal(commits, 0, 'candidate-selection Enter must not rename the session');

        widget.endSessionRenameComposition('中文输入法会话');
        assert.equal(widget.renameDraft, '中文输入法会话');
        widget.handleSessionRenameKeyDown(event(false, 13), 'active');
        assert.equal(commits, 0, 'the compositionend Enter task must still be ignored');
        assert.equal(typeof guardTimer, 'function');

        guardTimer();
        widget.handleSessionRenameKeyDown(event(false, 13), 'active');
        assert.equal(commits, 1, 'a later plain Enter commits the complete Chinese title');
        assert.equal(prevented, 1);
        assert.equal(stopped, 1);
    } finally {
        global.window.setTimeout = originalSetTimeout;
        global.window.clearTimeout = originalClearTimeout;
    }
});

test('an in-flight Chinese session rename does not block sending or roll back a newer lifecycle event', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const renameResult = deferred();
    const timeline = [];
    const current = session('active', 'completed', {
        title: '中文会话',
        updatedAt: '2026-07-19T00:02:00.000Z'
    });
    const staleRenameResponse = session('active', 'running', {
        title: '中文会话',
        updatedAt: '2026-07-19T00:01:00.000Z'
    });
    const snapshot = runtimeSnapshot('/fixture', [current], current.appSessionId);

    widget.renamingSessionId = current.appSessionId;
    widget.renameDraft = '  中文会话  ';
    widget.renameImeComposing = false;
    widget.renameImeCompositionJustEnded = false;
    widget.renameImeCompositionGuardTimer = undefined;
    widget.prompt = '重命名后继续发送';
    widget.draftImages = [];
    widget.imageReadsInFlight = 0;
    widget.submission = undefined;
    widget.sendPreparationInFlight = false;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 0;
    widget.sessionLoadGeneration = 0;
    widget.runtimePrewarmRequested = false;
    widget.runtimePrewarmTimer = undefined;
    widget.retryablePrompt = undefined;
    widget.cancelRequested = new Set();
    widget.roots = ['/fixture'];
    widget.providers = [{ id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription' }];
    widget.textarea = null;
    widget.model = {
        snapshot,
        updateSession: updated => {
            timeline.push(`model-update:${updated.status}`);
            snapshot.sessions = [updated];
        }
    };
    widget.commandService = {
        executeCommand: async () => { timeline.push('save-all'); }
    };
    widget.service = {
        renameSession: async (_sessionId, title) => {
            timeline.push(`rename:${title}`);
            return renameResult.promise;
        },
        startRuntime: async () => {
            timeline.push('unexpected-runtime-start');
            return snapshot;
        },
        loadSession: async () => {
            timeline.push('unexpected-session-load');
            return current;
        },
        sendPrompt: async request => {
            timeline.push(`prompt:${request.sessionId}:${request.text}`);
        }
    };
    widget.workspaceRoot = async () => '/fixture';
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => timeline.push(`paint:${widget.renamingSessionId ?? 'closed'}`);
    widget.hydratedSessionKeyState().add(widget.agentContextKey(
        snapshot.workspaceRoot,
        snapshot.providerId,
        current.appSessionId
    ));

    const renaming = widget.commitSessionRename(current.appSessionId);
    assert.equal(widget.renamingSessionId, undefined, 'the editor must close before rename IPC resolves');
    assert.equal(widget.renameDraft, '');
    assert.deepEqual(timeline.slice(0, 2), ['paint:closed', 'rename:中文会话']);

    await widget.send();
    assert.ok(timeline.includes('prompt:active:重命名后继续发送'),
        'rename IPC must not own the composer send mutex');
    assert.equal(widget.submission, undefined);
    assert.equal(widget.sendPreparationInFlight, false);

    renameResult.resolve(staleRenameResponse);
    await renaming;

    assert.equal(snapshot.sessions[0].status, 'completed');
    assert.equal(snapshot.sessions[0].updatedAt, current.updatedAt);
    assert.equal(timeline.some(entry => entry.startsWith('model-update:')), false,
        'the stale rename result must not roll lifecycle state back to running');
    assert.equal(timeline.includes('unexpected-runtime-start'), false);
    assert.equal(timeline.includes('unexpected-session-load'), false);
});

test('a Provider switch during send preparation never carries old draft images into the new service', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const timeline = [];
    const snapshot = runtimeSnapshot('/fixture', [], undefined);

    widget.prompt = '解释图片';
    widget.draftImages = [{
        id: 'image-a',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
        name: '旧服务图片.png',
        previewUrl: 'blob:fixture'
    }];
    widget.imageReadsInFlight = 0;
    widget.submission = undefined;
    widget.sendPreparationInFlight = false;
    widget.sessionLoading = false;
    widget.agentContextGeneration = 4;
    widget.roots = ['/fixture'];
    widget.model = {
        snapshot,
        refresh: async () => {
            timeline.push('refresh');
            snapshot.providerId = 'xora-relay';
            snapshot.models = [{ id: 'xora-relay', name: 'Relay' }];
            snapshot.selectedModel = 'xora-relay';
            // Mirrors reconcileAgentContext invalidating Provider A drafts.
            widget.agentContextGeneration += 1;
            widget.draftImages = [];
        }
    };
    widget.service = {
        startRuntime: async () => {
            timeline.push('runtime');
            return snapshot;
        },
        createSession: async () => {
            timeline.push('session/new');
            return session('created');
        },
        sendPrompt: async () => timeline.push('session/prompt')
    };
    widget.commandService = { executeCommand: async () => undefined };
    widget.messages = { info: () => undefined, warn: () => undefined, error: () => undefined };
    widget.update = () => undefined;

    await widget.send();

    assert.deepEqual(timeline, ['refresh']);
    assert.equal(widget.prompt, '解释图片', 'text remains as a draft in the new Provider');
    assert.equal(widget.submission, undefined);
    assert.match(widget.inlineNotice.message, /重新添加图片/);
});

test('cached local history becomes visible before ACP session restore completes', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const restore = deferred();
    const timeline = [];
    const history = [{ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'cached A' }];

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.sessionHistoryCatchup = new Map();
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

test('reopening the visible conversation hydrates it when the current Provider key is not ready', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const historical = session('visible-old-provider', 'idle', { providerId: 'old-relay' });
    const rebound = { ...historical, providerId: 'grok-subscription', model: 'grok-4.6' };
    const timeline = [];

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.sessionHistoryCatchup = new Map();
    widget.sessionHistoryPages = new Map();
    widget.hydratedSessionKeys = new Set();
    widget.roots = ['/fixture'];
    widget.sessionLoading = false;
    widget.workspaceRestorePending = false;
    widget.rememberOpenSessionTab = () => undefined;
    widget.agentContextKey = () => 'current-provider-visible-session';
    widget.imageDraftContextKey = () => 'current-provider-visible-session';
    widget.storeActiveComposerDraft = () => undefined;
    widget.resetTranscriptWindow = () => undefined;
    widget.activateComposerLane = () => undefined;
    widget.cachedSessionHistory = () => [];
    widget.followTranscript = () => undefined;
    widget.update = () => undefined;
    widget.model = {
        snapshot: {
            phase: 'ready',
            activeSessionId: historical.appSessionId,
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            sessions: [historical]
        },
        showSessionHistory: () => timeline.push('history-visible'),
        updateSession: loaded => timeline.push(`hydrated:${loaded.providerId}`)
    };
    widget.ensureSessionHydrated = async () => {
        timeline.push('load-session');
        return rebound;
    };

    await widget.openSession(historical);

    assert.deepEqual(timeline, [
        'history-visible',
        'load-session',
        'hydrated:grok-subscription'
    ]);
});

test('reopening a cached hydrated history performs no JSONL or ACP round trip', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const record = session('a', 'completed');
    const history = [{ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'cached A' }];
    const timeline = [];

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.sessionHistoryCatchup = new Map();
    widget.roots = ['/fixture'];
    widget.openPopover = 'history';
    widget.sessionLoading = false;
    widget.model = {
        snapshot: {
            phase: 'ready',
            activeSessionId: undefined,
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            sessions: [record]
        },
        showSessionHistory: (selected, events) => {
            widget.model.snapshot.activeSessionId = selected.appSessionId;
            timeline.push(`visible:${events[0]?.text ?? 'empty'}`);
        },
        updateSession: () => timeline.push('session-ready')
    };
    widget.service = {
        getSessionHistory: async () => {
            timeline.push('history-rpc');
            return history;
        },
        loadSession: async () => {
            timeline.push('load-rpc');
            return record;
        }
    };
    widget.messages = { error: () => timeline.push('error') };
    widget.update = () => undefined;
    widget.followTranscript = () => undefined;

    widget.cacheSessionHistory(record, history);
    widget.hydratedSessionKeyState().add(widget.agentContextKey('/fixture', 'grok-subscription', 'a'));
    await widget.openSession(record);

    assert.deepEqual(timeline, ['visible:cached A', 'session-ready']);
    assert.equal(widget.sessionLoading, false);
});

test('a loadSession metadata notification preserves history cache across A-B-A navigation', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const record = session('a', 'completed');
    const loaded = { ...record, updatedAt: '2026-07-19T00:01:00.000Z', status: 'idle' };
    const history = [{ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'durable A' }];
    let historyReads = 0;
    let sessionLoads = 0;

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.sessionHistoryCatchup = new Map();
    widget.roots = ['/fixture'];
    widget.sessionLoading = false;
    widget.submission = undefined;
    widget.model = {
        snapshot: {
            phase: 'ready',
            activeSessionId: undefined,
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            sessions: [record]
        },
        showSessionHistory: selected => {
            widget.model.snapshot.activeSessionId = selected.appSessionId;
        },
        updateSession: updated => {
            widget.model.snapshot.sessions = [updated];
        }
    };
    widget.service = {
        getSessionHistory: async () => {
            historyReads += 1;
            return history;
        },
        loadSession: async () => {
            sessionLoads += 1;
            // Mirrors Electron's notification ordering: metadata can arrive
            // before the loadSession RPC result reaches the renderer.
            widget.acceptAgentEvent({ kind: 'session', session: loaded });
            return loaded;
        }
    };
    widget.messages = { error: () => assert.fail('history restore must not fail') };
    widget.update = () => undefined;
    widget.followTranscript = () => undefined;

    await widget.openSession(record);
    // Simulate visiting B/new page and then returning to A. The loaded record
    // is the updatedAt authority published by the first restore.
    widget.model.snapshot.activeSessionId = undefined;
    await widget.openSession(loaded);

    assert.equal(historyReads, 1, 'returning to A must reuse the migrated transcript cache');
    assert.equal(sessionLoads, 1, 'returning to A must reuse the hydrated ACP session');
});

test('a project context change invalidates an in-flight widget session restore', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const restore = deferred();
    const timeline = [];

    widget.sessionLoadGeneration = 0;
    widget.agentContextGeneration = 0;
    widget.sessionHistoryCatchup = new Map();
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

test('reaching the top fetches an older backend page and preserves the visible scroll anchor', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const record = session('a', 'idle');
    const newest = {
        kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'newest'
    };
    const older = {
        kind: 'text-delta', sessionId: 'a', role: 'assistant', text: 'older'
    };
    let requested;
    let scrollHeight = 1_000;
    let scrollTop = 0;
    const node = {
        get scrollHeight() { return scrollHeight; },
        clientHeight: 400,
        get scrollTop() { return scrollTop; },
        set scrollTop(value) { scrollTop = value; }
    };

    widget.agentPaneView = 'conversation';
    widget.activityFilter = 'all';
    widget.renderedTranscriptLimit = 180;
    widget.sessionLoadGeneration = 7;
    widget.sessionHistoryCatchup = new Map();
    widget.sessionHistoryPages = new Map([['a', {
        events: [newest], before: 'opaque-before', hasMore: true
    }]]);
    widget.sessionHistoryCache = new Map();
    widget.model = {
        snapshot: { activeSessionId: 'a', sessions: [record] },
        transcript: [{ id: 'newest', kind: 'assistant', text: 'newest', payload: newest }],
        showSessionHistory: (_record, events) => {
            widget.model.transcript = events.map((event, index) => ({
                id: String(index), kind: 'assistant', text: event.text, payload: event
            }));
        }
    };
    widget.service = {
        getSessionHistoryPage: async (_sessionId, request) => {
            requested = request;
            return { events: [older], hasMore: false };
        }
    };
    widget.update = () => { scrollHeight = 1_200; };
    widget.showInlineNotice = message => assert.fail(message);

    await widget.revealEarlierTranscript(node);
    widget.bindTranscriptNode(node);

    assert.deepEqual(requested, { before: 'opaque-before', limit: 180 });
    assert.deepEqual(widget.model.transcript.map(entry => entry.text), ['older', 'newest']);
    assert.equal(scrollTop, 200, 'prepending must keep the previous first visible row anchored');
    assert.equal(widget.transcriptHistoryRevealPending, false);
    assert.equal(widget.sessionHistoryPages.get('a').hasMore, false);
});

test('transcript follows committed output only while the reader remains near the bottom', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    let updates = 0;
    let scrollTop = 600;
    const node = {
        scrollHeight: 1_000,
        clientHeight: 300,
        get scrollTop() { return scrollTop; },
        set scrollTop(value) { scrollTop = Math.min(value, this.scrollHeight - this.clientHeight); }
    };
    widget.agentPaneView = 'conversation';
    widget.stickToBottom = true;
    widget.newOutputAvailable = false;
    widget.transcriptFollowPending = false;
    widget.transcriptOutputPending = false;
    widget.update = () => updates++;

    // A stream update is applied against the DOM height from the completed
    // React commit and remains pinned to the latest message.
    widget.followTranscript(true);
    widget.bindTranscriptNode(node);
    assert.equal(scrollTop, 700);
    assert.equal(widget.newOutputAvailable, false);

    // A deliberate upward scroll detaches follow mode. Later stream commits
    // must preserve the reader's position and expose an explicit return chip.
    scrollTop = 280;
    widget.onTranscriptScroll(node);
    assert.equal(widget.stickToBottom, false);
    node.scrollHeight = 1_200;
    widget.followTranscript(true);
    widget.bindTranscriptNode(node);
    assert.equal(scrollTop, 280, 'new output must not steal an intentionally scrolled viewport');
    assert.equal(widget.newOutputAvailable, true);
    assert.equal(updates, 1);

    // Clicking the chip resumes live follow immediately.
    widget.transcriptNode = node;
    widget.scrollToBottom();
    assert.equal(scrollTop, 900);
    assert.equal(widget.stickToBottom, true);
    assert.equal(widget.newOutputAvailable, false);
});

test('a compact pure-empty conversation keeps the welcome panel at its top', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    let scrollTop = 60;
    const node = {
        scrollHeight: 413,
        clientHeight: 353,
        get scrollTop() { return scrollTop; },
        set scrollTop(value) { scrollTop = value; }
    };
    widget.agentPaneView = 'conversation';
    widget.stickToBottom = true;
    widget.newOutputAvailable = false;
    widget.transcriptFollowPending = true;
    widget.transcriptOutputPending = false;
    widget.model = { transcript: [], snapshot: {} };
    widget.visiblePendingSubmissions = () => [];
    widget.update = () => undefined;

    widget.bindTranscriptNode(node);
    assert.equal(scrollTop, 0);
});

test('metadata-only runtime changes do not masquerade as unread Agent messages', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    widget.model = {
        snapshot: { activeSessionId: 'a', phase: 'ready' },
        transcript: [{ id: 'assistant-a', kind: 'assistant', text: '正在处理' }]
    };
    widget.observedTranscriptSignature = widget.transcriptOutputSignature();

    widget.model.snapshot.phase = 'initializing';
    assert.equal(widget.observeTranscriptOutput(), false);

    widget.model.transcript[0].text += '。';
    assert.equal(widget.observeTranscriptOutput(), true);
    assert.equal(widget.observeTranscriptOutput(), false, 'one committed delta is announced only once');
});

test('same-length tool progress updates still count as new transcript output', () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    widget.model = {
        snapshot: { activeSessionId: 'a', phase: 'ready' },
        transcript: [{
            id: 'tool-a',
            kind: 'tool',
            payload: {
                kind: 'tool-call',
                sessionId: 'a',
                toolCallId: 'tool-a',
                title: '执行命令',
                toolName: 'terminal',
                status: 'running',
                output: 'step 1/9'
            }
        }]
    };
    widget.observedTranscriptSignature = widget.transcriptOutputSignature();

    widget.model.transcript[0].payload = {
        ...widget.model.transcript[0].payload,
        output: 'step 2/9'
    };
    assert.equal(widget.observeTranscriptOutput(), true);
    assert.equal(widget.observeTranscriptOutput(), false, 'the replacement payload is announced only once');
});
