const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const { GrokSidecarSupervisor } = require('../lib/electron-main/sidecar-supervisor');
const { resolveSharedGrokHome, sharedGrokHome } = require('../lib/electron-main/shared-grok-home');

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
        FrontendApplicationConfigProvider.set({ applicationName: 'Xora Code startup test' });
    } catch {
        // Another browser-oriented test may already have configured the singleton.
    }
    return require('../lib/browser/agent-widget').XoraAgentWidget;
}

async function flushAsyncWork() {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
}

test('a project prewarm retries a transient crash and becomes ready without editor input', async () => {
    const XoraAgentWidget = widgetClass();
    const widget = Object.create(XoraAgentWidget.prototype);
    const scheduled = new Map();
    let nextTimerId = 1;
    let starts = 0;
    const originalSetTimeout = global.window.setTimeout;
    const originalClearTimeout = global.window.clearTimeout;

    global.window.setTimeout = (callback, delay = 0) => {
        const id = nextTimerId++;
        scheduled.set(id, { callback, delay });
        return id;
    };
    global.window.clearTimeout = id => scheduled.delete(id);

    try {
        widget.submission = undefined;
        widget.sessionLoading = false;
        widget.runtimePrewarmRequested = true;
        widget.runtimePrewarmTimer = undefined;
        widget.runtimePrewarmAttemptKey = undefined;
        widget.runtimePrewarmAttempts = 0;
        widget.activeSessionHydrationKey = undefined;
        widget.observedRuntimePhase = 'stopped';
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
            refresh: async () => undefined
        };
        widget.service = {
            startRuntime: async () => {
                starts += 1;
                widget.model.snapshot.phase = 'starting';
                widget.reconcileRuntimePrewarmState();
                widget.model.snapshot.phase = 'initializing';
                widget.reconcileRuntimePrewarmState();
                if (starts === 1) {
                    widget.model.snapshot.phase = 'crashed';
                    widget.reconcileRuntimePrewarmState();
                    throw new Error('transient initialize timeout');
                }
                widget.model.snapshot.phase = 'ready';
                widget.reconcileRuntimePrewarmState();
                return { ...widget.model.snapshot };
            }
        };
        widget.update = () => undefined;

        // This is the project-open signal. No prompt, paste, suggestion or Send is
        // involved anywhere in the recovery path below.
        widget.scheduleRuntimePrewarm();

        for (let step = 0; step < 12 && widget.model.snapshot.phase !== 'ready'; step += 1) {
            const next = scheduled.entries().next().value;
            if (next) {
                const [id, timer] = next;
                scheduled.delete(id);
                timer.callback();
            }
            await flushAsyncWork();
        }

    assert.equal(widget.model.snapshot.phase, 'ready');
    assert.equal(starts, 2, 'one bounded recovery attempt should heal the cold start');
    assert.equal(widget.runtimePrewarmRequested, false);
    assert.equal(widget.runtimePrewarmAttemptKey, undefined, 'readiness must release the startup single-flight key');

        // A stale retry must not create another sidecar after readiness.
        for (const [id, timer] of [...scheduled]) {
            scheduled.delete(id);
            timer.callback();
            await flushAsyncWork();
        }
        assert.equal(starts, 2);
    } finally {
        global.window.setTimeout = originalSetTimeout;
        global.window.clearTimeout = originalClearTimeout;
    }
});

test('workspace attachment starts Agent standby before the Agent widget needs user input', async () => {
    widgetClass();
    const { WorkspaceTrustGuard } = require('../lib/browser/workspace-trust-guard');
    const { FileUri } = require('@theia/core/lib/common/file-uri');
    const fixtureRoot = FileUri.fsPath(FileUri.create(path.resolve('/fixture')));
    const guard = Object.create(WorkspaceTrustGuard.prototype);
    const calls = [];
    const snapshot = {
        phase: 'stopped',
        workspaceRoot: fixtureRoot,
        workspaceAttached: true,
        workspaceTrusted: false,
        providerId: 'xora-relay',
        models: [],
        sessions: [],
        permissionMode: 'request-approval'
    };
    guard.model = { snapshot };
    guard.workspaceTrustService = { getWorkspaceTrust: async () => false };
    guard.agentHost = {
        setWorkspaceRoot: async root => {
            calls.push(['root', root]);
            return snapshot;
        },
        synchronizeWorkspaceTrust: async request => {
            calls.push(['attach', request]);
            return snapshot;
        },
        listProviders: async () => {
            calls.push(['providers']);
            return [{
                id: 'xora-relay',
                name: 'Relay',
                kind: 'custom',
                credentialConfigured: true
            }];
        },
        startRuntime: async request => {
            calls.push(['start', request]);
            return { ...snapshot, phase: 'ready' };
        }
    };
    guard.lastSynchronizationSignature = undefined;
    guard.agentStandbyKey = undefined;

    const roots = [{ resource: FileUri.create(fixtureRoot) }];
    await guard.synchronize(roots, false);
    await flushAsyncWork();

    assert.deepEqual(calls, [
        ['root', fixtureRoot],
        ['attach', { workspaceRoots: [fixtureRoot], trusted: false }],
        ['providers'],
        ['start', { workspaceRoot: fixtureRoot, providerId: 'xora-relay' }]
    ]);
    assert.equal(guard.agentStandbyKey, undefined);
});

test('desktop ACP initialize uses cold-start hints and a release-grade timeout', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    const callStart = source.indexOf("acp.request<InitializeResponse>('initialize'");
    const callEnd = source.indexOf('if (generation !== this.runtimeGeneration)', callStart);
    assert.ok(callStart >= 0 && callEnd > callStart, 'the production initialize request must be present');
    const initializeCall = source.slice(callStart, callEnd);

    assert.match(initializeCall, /_meta:\s*\{/);
    assert.match(initializeCall, /startupHints:\s*\{/);
    assert.match(initializeCall, /nonInteractive:\s*true/);
    assert.match(initializeCall, /skipGitStatus:\s*true/);
    assert.match(initializeCall, /skipProjectLayout:\s*true/);

    const timeoutToken = initializeCall.match(/timeoutMs:\s*([A-Z][A-Z0-9_]*|[0-9][0-9_]*)/)?.[1];
    assert.ok(timeoutToken, 'initialize must have an explicit timeout');
    let timeoutMs;
    if (/^[0-9_]+$/.test(timeoutToken)) {
        timeoutMs = Number(timeoutToken.replaceAll('_', ''));
    } else {
        const declaration = source.match(new RegExp(`(?:const|readonly)\\s+${timeoutToken}\\s*=\\s*([0-9][0-9_]*)`));
        assert.ok(declaration, `initialize timeout constant ${timeoutToken} must have a numeric declaration`);
        timeoutMs = Number(declaration[1].replaceAll('_', ''));
    }
    assert.equal(timeoutMs, 45_000, 'desktop initialize must stay aligned with the release smoke timeout');
});

test('every production sidecar environment disables telemetry and implicit compatibility MCP discovery', () => {
    // commandEnvironment is intentionally public so launch and diagnostics use
    // exactly the same allowlisted environment construction.
    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    const environment = supervisor.commandEnvironment({
        FIXTURE_PROVIDER_KEY: 'fixture-secret',
        DISABLE_TELEMETRY: '0',
        GROK_CURSOR_MCPS_ENABLED: 'true',
        GROK_CLAUDE_MCPS_ENABLED: '1'
    });

    assert.equal(environment.DISABLE_TELEMETRY, '1');
    assert.equal(environment.FIXTURE_PROVIDER_KEY, 'fixture-secret');
    assert.equal(environment.XORA_CODE, '1');
    assert.equal(environment.GROK_CURSOR_MCPS_ENABLED, 'false');
    assert.equal(environment.GROK_CLAUDE_MCPS_ENABLED, 'false');
});

test('runtime MCP secrets can be registered dynamically before ACP writes them', () => {
    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    supervisor.exactSecrets = [];
    const log = [];
    supervisor.appendLog = value => log.push(value);

    supervisor.registerRedactionSecrets(['mcp-runtime-secret', '', 'mcp-runtime-secret']);
    assert.deepEqual(supervisor.exactSecrets, ['mcp-runtime-secret']);

    const source = 'MCP stderr: mcp-runtime-secret';
    assert.equal(supervisor.writeRedactedPrefix(source, source.length), source.length);
    assert.equal(log.join(''), 'MCP stderr: [REDACTED]');

    const before = [...supervisor.exactSecrets];
    assert.throws(
        () => supervisor.registerRedactionSecrets(
            Array.from({ length: 4_096 }, (_, index) => `overflow-${index}`)
        ),
        /redaction set is too large/
    );
    assert.deepEqual(supervisor.exactSecrets, before, 'a rejected update must be atomic');
});

test('subscription CLI and ACP commands receive one explicit shared Grok home', () => {
    // Windows desktop launches can inherit HOME from one shell and USERPROFILE
    // from another account/profile. Neither variable may independently choose
    // where the login command and the ACP runtime persist subscription state.
    assert.equal(
        resolveSharedGrokHome({
            HOME: 'D:\\conflicting-posix-home',
            USERPROFILE: 'E:\\conflicting-windows-profile'
        }, 'C:\\Users\\fixture', 'win32'),
        'C:\\Users\\fixture\\.grok'
    );
    assert.equal(
        resolveSharedGrokHome({
            HOME: '/tmp/conflicting-home',
            USERPROFILE: 'C:\\conflicting-profile'
        }, '/Users/fixture', 'darwin'),
        '/Users/fixture/.grok'
    );
    assert.equal(
        resolveSharedGrokHome({
            HOME: '/tmp/conflicting-home',
            USERPROFILE: 'C:\\conflicting-profile'
        }, '/home/fixture', 'linux'),
        '/home/fixture/.grok'
    );
    assert.equal(
        resolveSharedGrokHome({ GROK_HOME: '/opt/xora/shared-grok' }, '/home/fixture', 'linux'),
        '/opt/xora/shared-grok'
    );

    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    const environment = supervisor.commandEnvironment();
    assert.equal(environment.GROK_HOME, sharedGrokHome());
    assert.ok(path.isAbsolute(environment.GROK_HOME), 'GROK_HOME must be absolute before spawning Grok');
});

test('an isolated API Provider can override the shared Grok home explicitly', () => {
    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    const providerHome = path.resolve('/fixture/xora-provider-home');
    const environment = supervisor.commandEnvironment({ GROK_HOME: providerHome });

    assert.equal(environment.GROK_HOME, providerHome);
});

test('the watcher, registry and process supervisor share one Grok-home resolver', () => {
    for (const file of [
        'agent-host-manager.ts',
        'provider-registry.ts',
        'sidecar-supervisor.ts'
    ]) {
        const source = fs.readFileSync(path.join(__dirname, '../src/electron-main', file), 'utf8');
        assert.match(source, /sharedGrokHome/iu, `${file} must use the shared resolver`);
        assert.doesNotMatch(source, /join\(homedir\(\),\s*['"]\.grok['"]\)/u);
    }
});
