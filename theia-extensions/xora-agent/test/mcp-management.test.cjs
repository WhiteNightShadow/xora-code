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
    assert.equal(result.data.diagnostics.failingCount, 1);
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

test('MCP discovery read commands are allowed beside runtime but doctor stays isolated', async () => {
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
    assert.deepEqual(calls.map(call => call.options.allowWhileRuntime), [true, true, undefined]);
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
