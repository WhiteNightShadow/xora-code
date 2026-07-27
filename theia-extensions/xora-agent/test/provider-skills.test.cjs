const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse: parseToml } = require('smol-toml');

const { ProviderRegistry } = require('../lib/electron-main/provider-registry');

function customProvider(id = 'xora-skill-fixture') {
    return {
        id,
        name: `Fixture ${id}`,
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-fixture',
        contextWindow: 1_000_000,
        backendSearch: false,
        secretRef: `provider:${id}`
    };
}

function isolatedRegistry(directory) {
    const sharedHome = path.join(directory, 'shared-grok-home');
    const providerHomes = path.join(directory, 'provider-homes');
    fs.mkdirSync(sharedHome, { recursive: true, mode: 0o700 });
    const registry = Object.create(ProviderRegistry.prototype);
    registry.grokHomePath = sharedHome;
    registry.grokConfigPath = path.join(sharedHome, 'config.toml');
    registry.providerGrokHomesRoot = () => providerHomes;
    return { registry, sharedHome, providerHomes };
}

test('isolated API Provider homes copy only allowlisted skill configuration and link extension directories', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-provider-skills-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { registry, sharedHome } = isolatedRegistry(directory);
    fs.mkdirSync(path.join(sharedHome, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(sharedHome, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(sharedHome, 'skills', 'SKILL.md'), '# fixture\n');
    fs.writeFileSync(path.join(sharedHome, 'commands', 'review.md'), '# review\n');
    fs.writeFileSync(registry.grokConfigPath, [
        '[skills]',
        'paths = ["/opt/team-skills", "~/personal-skills"]',
        'ignore = ["draft-skill"]',
        'disabled = ["unsafe-skill"]',
        'unexpected = "must-not-copy"',
        '',
        '[compat.cursor]',
        'skills = true',
        'mcp = true',
        '',
        '[compat.claude]',
        'skills = false',
        'hooks = true',
        '',
        '[auth]',
        'token = "shared-secret-value"',
        '',
        '[hooks]',
        'command = "external-hook"',
        '',
        '[permissions]',
        'mode = "external-permission"',
        '',
        '[mcp_servers.fixture]',
        'bearer_token = "shared-secret-value"',
        '',
        '[plugins]',
        'paths = ["/opt/executable-plugin"]',
        ''
    ].join('\n'), { mode: 0o600 });

    const home = registry.ensureApiProviderGrokHome(customProvider());
    const generated = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const parsed = parseToml(generated);

    assert.deepEqual(parsed.skills.paths, ['/opt/team-skills', '~/personal-skills']);
    assert.deepEqual(parsed.skills.ignore, ['draft-skill']);
    assert.deepEqual(parsed.skills.disabled, ['unsafe-skill']);
    assert.deepEqual(Object.keys(parsed.skills).sort(), ['disabled', 'ignore', 'paths']);
    assert.deepEqual(Object.keys(parsed.compat.cursor), ['skills']);
    assert.deepEqual(Object.keys(parsed.compat.claude), ['skills']);
    assert.equal(parsed.compat.cursor.skills, true);
    assert.equal(parsed.compat.claude.skills, false);
    for (const forbidden of ['auth', 'hooks', 'permissions', 'mcp_servers', 'plugins']) {
        assert.equal(parsed[forbidden], undefined, `${forbidden} must not cross the isolated-home boundary`);
    }
    assert.doesNotMatch(generated, /shared-secret-value|external-hook|external-permission|executable-plugin/);
    assert.equal(fs.realpathSync(path.join(home, 'skills')), fs.realpathSync(path.join(sharedHome, 'skills')));
    assert.equal(fs.realpathSync(path.join(home, 'commands')), fs.realpathSync(path.join(sharedHome, 'commands')));
    assert.equal(fs.lstatSync(path.join(home, 'skills')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(home, 'commands')).isSymbolicLink(), true);
});

test('isolated Provider skill configuration refreshes after the shared allowlist changes', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-provider-skill-refresh-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { registry } = isolatedRegistry(directory);
    const profile = customProvider('xora-refresh-fixture');
    fs.writeFileSync(registry.grokConfigPath, '[skills]\npaths = ["/first"]\n');

    const home = registry.ensureApiProviderGrokHome(profile);
    assert.deepEqual(parseToml(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).skills.paths, ['/first']);

    fs.writeFileSync(registry.grokConfigPath, [
        '[skills]',
        'paths = ["/second"]',
        'ignore = ["draft"]',
        '',
        '[compat.cursor]',
        'skills = true',
        ''
    ].join('\n'));
    registry.ensureApiProviderGrokHome(profile);

    const refreshed = parseToml(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
    assert.deepEqual(refreshed.skills.paths, ['/second']);
    assert.deepEqual(refreshed.skills.ignore, ['draft']);
    assert.equal(refreshed.compat.cursor.skills, true);
});

test('isolated Provider homes reject existing external links and real extension directories without replacing them', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-provider-skill-links-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { registry, sharedHome, providerHomes } = isolatedRegistry(directory);
    const profile = customProvider('xora-link-fixture');
    const home = path.join(providerHomes, profile.id);
    const external = path.join(directory, 'external-skills');
    fs.mkdirSync(path.join(sharedHome, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(sharedHome, 'commands'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'sentinel'), 'keep');
    fs.symlinkSync(external, path.join(home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(() => registry.ensureApiProviderGrokHome(profile), /points outside the shared Grok home/);
    assert.equal(fs.realpathSync(path.join(home, 'skills')), fs.realpathSync(external));
    assert.equal(fs.readFileSync(path.join(external, 'sentinel'), 'utf8'), 'keep');

    fs.unlinkSync(path.join(home, 'skills'));
    fs.symlinkSync(path.join(sharedHome, 'skills'), path.join(home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(home, 'commands'));
    fs.writeFileSync(path.join(home, 'commands', 'sentinel'), 'keep');

    assert.throws(() => registry.ensureApiProviderGrokHome(profile), /refused to replace the existing commands directory/);
    assert.equal(fs.readFileSync(path.join(home, 'commands', 'sentinel'), 'utf8'), 'keep');
});

test('public refresh and management environment APIs target custom and selected Providers', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    const metadata = {
        schemaVersion: 1,
        selectedProviderId: 'xora-two',
        providers: [customProvider('xora-one'), customProvider('xora-two')]
    };
    registry.readMetadata = () => metadata;
    const refreshed = [];
    registry.ensureApiProviderGrokHome = profile => {
        refreshed.push(profile.id);
        return `/fixture/${profile.id}`;
    };
    registry.refreshCustomProviderSkillViews();
    assert.deepEqual(refreshed, ['xora-one', 'xora-two']);

    assert.deepEqual(registry.managementEnvironment(), { GROK_HOME: '/fixture/xora-two' });
    assert.deepEqual(registry.managementEnvironment('xora-one'), { GROK_HOME: '/fixture/xora-one' });
    assert.deepEqual(registry.managementEnvironment('grok-subscription'), {});
    assert.deepEqual(refreshed, ['xora-one', 'xora-two', 'xora-two', 'xora-one']);
});
