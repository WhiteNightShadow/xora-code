const assert = require('node:assert/strict');
const test = require('node:test');

const {
    mergeMcpManagementResults,
    redactMcpDisplayText
} = require('../lib/electron-main/mcp-management');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

test('inspect remains authoritative when Grok native MCP list omits compatibility sources', () => {
    const result = mergeMcpManagementResults({
        ok: true,
        data: {
            mcpServers: [
                {
                    name: 'claude-tools', vendor: 'claude', transport: 'stdio',
                    source: { type: 'claude', path: '/fixture/claude.json' },
                    target: 'node server.js', compatibilityStatus: 'enabled'
                },
                {
                    name: 'cursor-tools', vendor: 'cursor', transport: 'stdio',
                    source: { type: 'cursor', path: '/fixture/mcp.json' },
                    target: 'npx fixture', compatibilityStatus: 'enabled'
                }
            ]
        }
    }, { ok: true, data: [] });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data.mcpServers.map(server => server.name), ['claude-tools', 'cursor-tools']);
    assert.equal(result.data.mcpServers[0].vendor, 'claude');
    assert.deepEqual(result.data.mcpServers[0].discoveredBy, ['inspect']);
    assert.equal(result.data.sources.inspect, 'ok');
    assert.equal(result.data.sources.nativeList, 'ok');
});

test('native configuration and doctor health enrich without replacing inspect origin', () => {
    const result = mergeMcpManagementResults({
        ok: true,
        data: {
            mcpServers: [{
                name: 'shared', vendor: 'cursor', transport: 'stdio', target: 'node compat.js',
                source: { type: 'cursor', path: '/fixture/mcp.json' }, compatibilityStatus: 'enabled'
            }]
        }
    }, {
        ok: true,
        data: [{ name: 'shared', transport: 'http', url: 'https://native.invalid/mcp', scope: 'user' }]
    }, {
        ok: true,
        data: {
            servers: [{
                name: 'shared', healthy: false,
                checks: [{ label: 'handshake failed', passed: false, detail: 'connection closed' }]
            }],
            healthy_count: 0,
            failing_count: 1
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.mcpServers.length, 1);
    const server = result.data.mcpServers[0];
    assert.equal(server.vendor, 'cursor');
    assert.equal(server.transport, 'stdio');
    assert.equal(server.target, 'node compat.js');
    assert.deepEqual(server.discoveredBy, ['inspect', 'native-list', 'doctor']);
    assert.equal(server.status, 'unhealthy');
    assert.equal(server.health.healthy, false);
    assert.equal(server.configured, true);
    assert.equal(server.diagnosticState, 'unhealthy');
    assert.equal(server.runtimeState, 'not-loaded');
    assert.equal(server.callable, false);
    assert.equal(result.data.diagnostics.failingCount, 1);
});

test('runtime readiness is distinct from discovery and diagnosis', () => {
    const result = mergeMcpManagementResults({
        ok: true,
        data: {
            mcpServers: [
                { name: 'compat-only', vendor: 'cursor', transport: 'stdio', compatibilityStatus: 'enabled' },
                { name: 'native-ready', vendor: 'grok', transport: 'stdio', compatibilityStatus: 'enabled' },
                { name: 'disabled-runtime', vendor: 'grok', transport: 'stdio', compatibilityStatus: 'enabled' }
            ]
        }
    }, {
        ok: true,
        data: [
            { name: 'native-ready', transport: 'stdio', command: 'node' },
            { name: 'disabled-runtime', transport: 'stdio', command: 'node' }
        ]
    }, {
        ok: true,
        data: { servers: [{ name: 'native-ready', healthy: true }] }
    }, {
        sessionId: 'session-1',
        configuredNames: ['native-ready', 'disabled-runtime'],
        enabledNames: ['native-ready'],
        servers: [
            { name: 'native-ready', status: 'ready', enabled: true, toolCount: 35 },
            { name: 'disabled-runtime', status: 'ready', enabled: false, toolCount: 35 }
        ]
    });

    assert.equal(result.data.schemaVersion, 2);
    const compat = result.data.mcpServers.find(server => server.name === 'compat-only');
    assert.equal(compat.configured, false);
    assert.equal(compat.importRequired, true);
    assert.equal(compat.callable, false);
    const ready = result.data.mcpServers.find(server => server.name === 'native-ready');
    assert.equal(ready.configured, true);
    assert.equal(ready.diagnosticState, 'healthy');
    assert.equal(ready.runtimeState, 'loaded');
    assert.equal(ready.callable, true);
    assert.equal(ready.selectable, true);
    assert.equal(ready.runtime.toolCount, 35);
    const disabled = result.data.mcpServers.find(server => server.name === 'disabled-runtime');
    assert.equal(disabled.runtimeState, 'disabled');
    assert.equal(disabled.callable, false);
    assert.equal(disabled.selectable, false);
});

test('canonical configured MCP remains selectable before the first ACP session exists', () => {
    const result = mergeMcpManagementResults(
        { ok: true, data: { mcpServers: [] } },
        { ok: true, data: [] },
        undefined,
        {
            configuredNames: ['camoufox-reverse', 'disabled-server'],
            enabledNames: ['camoufox-reverse'],
            servers: []
        }
    );

    assert.equal(result.ok, true);
    const camoufox = result.data.mcpServers.find(server => server.name === 'camoufox-reverse');
    assert.equal(camoufox.configured, true);
    assert.equal(camoufox.runtimeState, 'not-loaded');
    assert.equal(camoufox.callable, false);
    assert.equal(camoufox.selectable, true);
    const disabled = result.data.mcpServers.find(server => server.name === 'disabled-server');
    assert.equal(disabled.selectable, false);
});

test('partial command failures keep discovered servers and expose safe warnings', () => {
    const result = mergeMcpManagementResults({
        ok: true,
        data: { mcpServers: [{ name: 'compat', vendor: 'claude', transport: 'stdio' }] }
    }, {
        ok: false,
        error: 'native list unavailable'
    }, {
        ok: false,
        error: 'doctor timed out'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data.mcpServers.map(server => server.name), ['compat']);
    assert.equal(result.data.warnings.length, 2);
    assert.match(result.data.warnings[0], /原生 MCP 配置/);
    assert.match(result.data.warnings[1], /诊断/);
});

test('renderer MCP overview removes common secrets from targets and diagnostics', () => {
    const secret = 'never-cross-ipc';
    const result = mergeMcpManagementResults({
        ok: true,
        data: {
            mcpServers: [{
                name: 'secret-server', transport: 'stdio',
                target: `TOKEN=${secret} node server --api-key ${secret} https://u:p@example.test/mcp?token=${secret}`,
                source: { type: 'cursor', path: '/fixture/mcp.json', token: secret }
            }]
        }
    }, { ok: true, data: [] }, {
        ok: true,
        data: { servers: [{ name: 'secret-server', healthy: false, checks: [{ label: 'failed', detail: `--token=${secret}` }] }] }
    });

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /REDACTED/);
    assert.equal(redactMcpDisplayText('https://user:pass@example.test/mcp'), 'https://[REDACTED]@example.test/mcp');
});

test('MCP discovery and explicit doctor are allowed beside an idle runtime', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const calls = [];
    host.workspaceRoot = '/fixture';
    host.mcpDoctorSnapshot = undefined;
    host.isWorkspaceTrusted = () => true;
    host.runCli = async (args, expectJson, options = {}) => {
        calls.push({ args, expectJson, options });
        if (args[0] === 'inspect') return { ok: true, data: { mcpServers: [{ name: 'compat' }] } };
        if (args[1] === 'list') return { ok: true, data: [] };
        return { ok: true, data: { servers: [{ name: 'compat', healthy: true }] } };
    };

    const listed = await host.runManagementCommand('mcp-list');
    assert.equal(listed.ok, true);
    assert.deepEqual(calls.map(call => call.options.allowWhileRuntime), [true, true]);

    calls.length = 0;
    const diagnosed = await host.runManagementCommand('mcp-doctor');
    assert.equal(diagnosed.ok, true);
    assert.deepEqual(calls.map(call => call.options.allowWhileRuntime), [true, true, true]);
    assert.equal(diagnosed.data.mcpServers[0].status, 'healthy');
});

test('MCP overview fails only when every available discovery source fails', () => {
    const result = mergeMcpManagementResults(
        { ok: false, error: 'inspect failed' },
        { ok: false, error: 'list failed' }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /最终生效配置/);
    assert.match(result.error, /原生 MCP 配置/);
});
