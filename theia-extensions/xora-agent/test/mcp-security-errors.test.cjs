const assert = require('node:assert/strict');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');

test('Provider TOML validation never includes parser source diagnostics', () => {
    const secret = 'parser-line-secret-that-must-not-leak';
    const malformed = [
        '[mcp_servers.remote]',
        `headers = { Authorization = "Bearer ${secret}"`
    ].join('\n');
    assert.throws(
        () => ProviderRegistry.prototype.assertToml.call({}, malformed),
        error => {
            assert.equal(error.message, 'Grok config.toml is invalid; Xora Code left it unchanged.');
            assert.doesNotMatch(error.message, new RegExp(secret));
            return true;
        }
    );
});

test('Agent integration management redacts thrown secret values', async () => {
    const secret = 'management-secret-that-must-not-cross-rpc';
    const host = Object.create(GrokAgentHostService.prototype);
    host.workspaceRoot = '/fixture';
    host.currentSecrets = [secret];
    host.activePrompts = new Map();
    host.integrationMutationTail = Promise.resolve();
    host.isWorkspaceTrusted = () => true;
    host.providers = {
        updateSkills() {
            throw new Error(`credential failure: ${secret}`);
        }
    };

    const result = await host.manage({ area: 'skills', action: 'add', source: '/fixture/skills' });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, new RegExp(secret));
    assert.match(result.error, /REDACTED/);
});

test('MCP enable and disable actions persist through ProviderRegistry and request a hot refresh', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const changes = [];
    let refreshes = 0;
    host.workspaceRoot = '/fixture';
    host.currentSecrets = [];
    host.activePrompts = new Map();
    host.integrationMutationTail = Promise.resolve();
    host.lifecycleTail = Promise.resolve();
    host.isWorkspaceTrusted = () => true;
    host.providers = {
        updateMcpEnabled(...args) { changes.push(args); }
    };
    host.refreshIntegrationsLocked = async () => { refreshes += 1; };

    const disabled = await host.manage({ area: 'mcp', action: 'disable', name: 'browser', scope: 'project' });
    const enabled = await host.manage({ area: 'mcp', action: 'enable', name: 'browser', scope: 'project' });

    assert.equal(disabled.ok, true);
    assert.equal(enabled.ok, true);
    assert.deepEqual(changes, [
        ['/fixture', 'browser', false, 'project'],
        ['/fixture', 'browser', true, 'project']
    ]);
    assert.equal(refreshes, 2);
});

test('settings show configured Skills plus Xora-disabled entries, not bundled or compatibility discoveries', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    host.workspaceRoot = '/fixture';
    host.providerId = 'grok-subscription';
    host.activePrompts = new Map();
    host.isWorkspaceTrusted = () => true;
    host.providers = {
        managementEnvironment: () => ({}),
        disabledSkills: () => ['disabled-review']
    };
    host.runCli = async () => ({
        ok: true,
        data: { skills: [
            { name: 'active-review', source: { type: 'configToml', path: '/fixture/SKILL.md' } },
            { name: 'bundled-review', source: { type: 'bundled', path: '/fixture/bundled/SKILL.md' } },
            { name: 'cursor-review', source: { type: 'user', path: '/fixture/cursor/SKILL.md' }, vendor: 'cursor' }
        ] }
    });

    const result = await host.inspect();
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.skills.map(skill => [skill.name, skill.enabled]), [
        ['active-review', true],
        ['disabled-review', false]
    ]);
});
