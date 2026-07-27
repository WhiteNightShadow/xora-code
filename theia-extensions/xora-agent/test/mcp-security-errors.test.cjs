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
