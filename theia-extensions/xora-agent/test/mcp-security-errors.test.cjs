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

test('settings preserve Grok Skills discovery across native user/project/configured sources and disabled entries', async () => {
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
            { name: 'user-review', source: { type: 'user', path: '/shared/.grok/skills/user-review/SKILL.md' } },
            { name: 'project-review', source: { type: 'project', path: '/fixture/.grok/skills/project-review/SKILL.md' } },
            { name: 'project-disabled', enabled: false, source: { type: 'project', path: '/fixture/.grok/skills/project-disabled/SKILL.md' } },
            { name: 'bundled-review', source: { type: 'bundled', path: '/fixture/bundled/SKILL.md' } },
            { name: 'cursor-review', source: { type: 'user', path: '/fixture/cursor/SKILL.md' }, vendor: 'cursor' }
        ] }
    });

    const result = await host.inspect();
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.skills.map(skill => [skill.name, skill.enabled]), [
        ['active-review', true],
        ['user-review', true],
        ['project-review', true],
        ['project-disabled', false],
        ['bundled-review', true],
        ['cursor-review', true],
        ['disabled-review', false]
    ]);
});

test('Skills inventory remains visible when switching between custom Provider homes', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    host.workspaceRoot = '/fixture';
    host.activePrompts = new Map();
    host.isWorkspaceTrusted = () => true;
    const calls = [];
    host.providers = {
        managementEnvironment: providerId => ({ GROK_HOME: `/isolated/${providerId}` }),
        disabledSkills: () => ['disabled-review']
    };
    host.runCli = async (args, _json, options) => {
        calls.push({ args, ...options });
        return { ok: true, data: { skills: [
            { name: 'shared-review', source: { type: host.providerId === 'custom-one' ? 'user' : 'configToml', path: '/shared/skills/review/SKILL.md' } },
            { name: 'project-review', source: { type: 'project', path: '/fixture/.grok/skills/review/SKILL.md' } }
        ] } };
    };
    const inventories = [];
    for (const providerId of ['custom-one', 'custom-two']) {
        host.providerId = providerId;
        const result = await host.inspect();
        assert.equal(result.ok, true);
        inventories.push(result.data.skills.map(skill => [skill.name, skill.enabled]));
    }
    assert.deepEqual(inventories[0], inventories[1]);
    assert.deepEqual(inventories[0], [['shared-review', true], ['project-review', true], ['disabled-review', false]]);
    assert.deepEqual(calls.map(call => call.injectedEnvironment.GROK_HOME), ['/isolated/custom-one', '/isolated/custom-two']);
    assert.deepEqual(calls.map(call => call.cwd), ['/fixture', '/fixture']);
});

test('late Skills discovery cannot cross a workspace change or trust revocation', async () => {
    for (const transition of ['workspace', 'trust']) {
        const host = Object.create(GrokAgentHostService.prototype);
        let trusted = true;
        host.workspaceRoot = '/fixture';
        host.activePrompts = new Map();
        host.isWorkspaceTrusted = () => trusted;
        host.providers = { managementEnvironment: () => ({}), disabledSkills: () => [] };
        let complete;
        host.runCli = () => new Promise(resolve => { complete = resolve; });
        const inspecting = host.inspect();
        if (transition === 'workspace') host.workspaceRoot = '/another-workspace';
        else trusted = false;
        complete({ ok: true, data: { skills: [{ name: 'old-workspace-skill' }] } });
        const result = await inspecting;
        assert.equal(result.ok, false);
        assert.equal(result.data, undefined);
    }
});
