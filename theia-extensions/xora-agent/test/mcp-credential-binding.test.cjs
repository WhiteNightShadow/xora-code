const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse: parseToml } = require('smol-toml');

const { ProviderRegistry } = require('../lib/electron-main/provider-registry');
const { RuntimeMcpRegistry } = require('../lib/electron-main/runtime-mcp-registry');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-mcp-credential-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'workspace');
    const grokHome = path.join(directory, 'grok-home');
    const userData = path.join(directory, 'user-data');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(grokHome, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });

    const values = new Map();
    const vault = {
        get: reference => values.get(reference),
        set: (reference, value) => values.set(reference, value),
        delete: reference => values.delete(reference)
    };
    const providers = Object.create(ProviderRegistry.prototype);
    providers.vault = vault;
    providers.grokHomePath = grokHome;
    providers.grokConfigPath = path.join(grokHome, 'config.toml');
    providers.mcpCredentialPath = path.join(userData, 'mcp-credentials.json');
    providers.metadataLockPath = path.join(userData, '.providers.lock');
    providers.withFileLock = (_lock, _message, operation) => operation();
    providers.backupConfig = () => undefined;

    const runtime = new RuntimeMcpRegistry({ grokHome });
    return { workspace, grokHome, providers, runtime, values };
}

test('stdio MCP credentials are bound to canonical config, enter only their ACP env, and never enter TOML', t => {
    const files = fixture(t);
    fs.writeFileSync(files.providers.grokConfigPath, [
        '[mcp_servers.alpha]',
        'command = "node"',
        'args = ["alpha.js"]',
        ''
    ].join('\n'));
    const alias = path.join(path.dirname(files.workspace), 'workspace-alias');
    fs.symlinkSync(files.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');

    files.providers.configureMcpCredentialReference(alias, 'user', 'alpha', 'ALPHA_TOKEN', 'stdio');
    const identity = files.runtime.credentialConfigurationIdentity(files.workspace, 'alpha', 'ALPHA_TOKEN');
    assert.match(identity, /^[0-9a-f]{64}$/);
    files.providers.saveMcpCredential(alias, 'alpha', 'ALPHA_TOKEN', identity, 'alpha-secret-value');

    const source = fs.readFileSync(files.providers.grokConfigPath, 'utf8');
    const parsed = parseToml(source);
    assert.equal(parsed.mcp_servers.alpha.env.ALPHA_TOKEN, '${ALPHA_TOKEN}');
    assert.doesNotMatch(source, /alpha-secret-value/);
    const metadataSource = fs.readFileSync(files.providers.mcpCredentialPath, 'utf8');
    const metadata = JSON.parse(metadataSource);
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.credentials[0].workspaceRoot, fs.realpathSync(files.workspace));
    assert.equal(metadata.credentials[0].configIdentity, identity);
    assert.doesNotMatch(metadataSource, /alpha-secret-value/);

    const bindings = files.providers.mcpCredentialBindings(files.workspace);
    const snapshot = files.runtime.resolve(files.workspace, {}, bindings);
    assert.deepEqual(snapshot.mcpServers, [{
        name: 'alpha',
        command: 'node',
        args: ['alpha.js'],
        env: [{ name: 'ALPHA_TOKEN', value: 'alpha-secret-value' }]
    }]);
    assert.deepEqual(snapshot.redactionValues, ['alpha-secret-value']);
});

test('legacy, changed-config, and cross-server MCP credential bindings fail closed', t => {
    const files = fixture(t);
    fs.writeFileSync(files.providers.grokConfigPath, [
        '[mcp_servers.alpha]',
        'command = "node"',
        'args = ["alpha.js"]',
        '',
        '[mcp_servers.alpha.env]',
        'ALPHA_TOKEN = "${ALPHA_TOKEN}"',
        ''
    ].join('\n'));
    const identity = files.runtime.credentialConfigurationIdentity(files.workspace, 'alpha', 'ALPHA_TOKEN');
    files.providers.saveMcpCredential(files.workspace, 'alpha', 'ALPHA_TOKEN', identity, 'alpha-secret-value');
    const bindings = files.providers.mcpCredentialBindings(files.workspace);

    fs.writeFileSync(files.providers.grokConfigPath, [
        '[mcp_servers.alpha]',
        'command = "node"',
        'args = ["changed-endpoint.js"]',
        '',
        '[mcp_servers.alpha.env]',
        'ALPHA_TOKEN = "${ALPHA_TOKEN}"',
        ''
    ].join('\n'));
    assert.deepEqual(files.runtime.credentialEnvironment(files.workspace, bindings), {});
    const changed = files.runtime.resolve(files.workspace, {}, bindings);
    assert.deepEqual(changed.mcpServers, []);
    assert.equal(changed.issues[0].code, 'missing-environment');
    assert.match(changed.issues[0].message, /ALPHA_TOKEN/);

    fs.writeFileSync(files.providers.grokConfigPath, [
        '[mcp_servers.beta]',
        'command = "node"',
        'args = ["beta.js"]',
        '',
        '[mcp_servers.beta.env]',
        'ALPHA_TOKEN = "${ALPHA_TOKEN}"',
        ''
    ].join('\n'));
    const crossServer = files.runtime.resolve(files.workspace, {}, bindings);
    assert.deepEqual(crossServer.mcpServers, [], 'a credential bound to alpha must never satisfy beta');
    assert.equal(crossServer.issues[0].code, 'missing-environment');

    fs.writeFileSync(files.providers.mcpCredentialPath, JSON.stringify({
        schemaVersion: 1,
        credentials: [{
            workspaceRoot: files.workspace,
            server: 'beta',
            environmentName: 'ALPHA_TOKEN',
            secretRef: 'mcp:legacy-unbound'
        }]
    }));
    files.values.set('mcp:legacy-unbound', 'legacy-secret');
    assert.deepEqual(files.providers.mcpCredentialBindings(files.workspace), []);
});
