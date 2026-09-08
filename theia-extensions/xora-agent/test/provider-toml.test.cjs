const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse: parseToml } = require('smol-toml');

const {
    MANAGED_BLOCK_END,
    MANAGED_BLOCK_START,
    LEGACY_MANAGED_BLOCK_START,
    LEGACY_MANAGED_BLOCK_END,
    assertManagedProviderMarkers,
    assertUnmanagedTomlPreserved,
    setTomlValue,
    removeMarkedManagedBlocksFromToml,
    removeModelTableFromToml,
    removeModelTablesFromToml
} = require('../lib/electron-main/provider-toml');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');
const {
    effectiveProviderReasoningConfiguration,
    PROVIDER_REASONING_AUTO_POLICY_VERSION
} = require('../lib/common/agent-protocol');

function customProvider(protocol = 'openai-responses', reasoning) {
    return {
        id: 'xora-reasoning-test',
        name: 'Reasoning test',
        kind: 'custom',
        protocol,
        baseUrl: 'https://api.example.com/v1',
        model: 'provider-model',
        contextWindow: 500000,
        backendSearch: false,
        secretRef: 'provider:xora-reasoning-test',
        ...(reasoning ? { reasoning } : {})
    };
}

test('removeModelTable strips both bare and quoted model tables', () => {
    const source = [
        '[ui]',
        'yolo = false',
        '',
        '[model.xora-mru8evto]',
        'model = "grok-4.5"',
        'base_url = "https://example.com/v1"',
        '',
        '[cli]',
        'installer = "internal"',
        ''
    ].join('\n');

    const cleaned = removeModelTableFromToml(source, 'xora-mru8evto');
    assert.doesNotMatch(cleaned, /model\.xora-mru8evto/);
    assert.match(cleaned, /\[ui\]/);
    assert.match(cleaned, /\[cli\]/);
    parseToml(cleaned);
});

test('rewrite recovery: bare orphan + quoted managed block no longer redefines', () => {
    const orphan = [
        '[ui]',
        'yolo = false',
        '',
        '[model.xora-mru8evto]',
        'model = "old"',
        'base_url = "https://old.example/v1"',
        ''
    ].join('\n');

    const managed = [
        MANAGED_BLOCK_START,
        '',
        '[model."xora-mru8evto"]',
        'model = "grok-4.5"',
        'base_url = "https://modyx.ai/v1"',
        'name = "grok中转站"',
        'api_backend = "responses"',
        'context_window = 1000000',
        'supports_backend_search = true',
        'env_key = "XORA_CODE_XORA_MRU8EVTO_API_KEY"',
        '',
        MANAGED_BLOCK_END,
        ''
    ].join('\n');

    // Simulate the pre-fix failure: orphan bare table + appended managed block.
    const broken = `${orphan}\n${managed}`;
    assert.throws(() => parseToml(broken));

    let fixed = removeMarkedManagedBlocksFromToml(broken);
    fixed = removeModelTablesFromToml(fixed, ['xora-mru8evto', 'xora-xai-api']);
    fixed = `${fixed.trimEnd()}\n\n${managed}`;
    parseToml(fixed);
    assert.equal((fixed.match(/\[model\./g) || []).length, 1);
});

test('removeMarkedManagedBlocks removes complete marker pairs only', () => {
    const source = [
        '[ui]',
        'a = 1',
        MANAGED_BLOCK_START,
        '[model."xora-a"]',
        'model = "m"',
        MANAGED_BLOCK_END,
        '[cli]',
        'b = 2'
    ].join('\n');
    const cleaned = removeMarkedManagedBlocksFromToml(source);
    assert.doesNotMatch(cleaned, /xora-a/);
    assert.match(cleaned, /\[ui\]/);
    assert.match(cleaned, /\[cli\]/);
});

test('Provider markers never own shared Skills or MCP sections inside the marker pair', () => {
    const source = [
        '# user configuration',
        MANAGED_BLOCK_START,
        '[model."xora-old"]',
        'base_url = "https://old.example/v1"',
        'model = "old"',
        '',
        '# [skills]',
        '# paths = ["/commented-user-skills"]',
        '# [mcp_servers.commented-user-server]',
        '# imported skill locations must survive',
        '["skills"]',
        String.raw`paths = ['C:\Users\tester\.codex\skills', 'D:\团队\skills']`,
        'disabled = ["draft"]',
        '',
        '["mcp_servers" . "camoufox-reverse"]',
        'command = "node"',
        'args = ["mcp-server.js"]',
        'env = { KEEP = "user-value" }',
        MANAGED_BLOCK_END,
        '[ui]',
        'theme = "dark"',
        ''
    ].join('\r\n');
    const before = parseToml(source);
    const cleaned = removeMarkedManagedBlocksFromToml(source);
    const after = parseToml(cleaned);
    assert.deepEqual(after.skills, before.skills);
    assert.deepEqual(after.mcp_servers, before.mcp_servers);
    assert.deepEqual(after.ui, before.ui);
    assert.equal(after.model, undefined);
    assert.match(cleaned, /imported skill locations must survive/);
    assert.match(cleaned, /# paths = \["\/commented-user-skills"\]/);
    assert.match(cleaned, /# \[mcp_servers\.commented-user-server\]/);
    assertUnmanagedTomlPreserved(source, cleaned, ['xora-old']);
});

test('markers and table-like lines inside multiline TOML strings are ordinary user content', () => {
    const source = [
        'notes = """',
        MANAGED_BLOCK_START,
        '[model.xora-fake]',
        MANAGED_BLOCK_END,
        '"""',
        "literal = '''",
        LEGACY_MANAGED_BLOCK_START,
        '[skills]',
        LEGACY_MANAGED_BLOCK_END,
        "'''",
        '# user comment mentioning ' + MANAGED_BLOCK_START,
        '[skills]',
        'paths = []',
        ''
    ].join('\n');
    assert.doesNotThrow(() => assertManagedProviderMarkers(source));
    assert.equal(removeMarkedManagedBlocksFromToml(source), source);
    assert.equal(removeModelTableFromToml(source, 'xora-fake'), source);
});

test('marker comments inserted inside a preexisting model do not claim its outer table', () => {
    const source = [
        '[model.xora-user-defined]',
        'model = "user-model"',
        MANAGED_BLOCK_START,
        'temperature = 0.2',
        MANAGED_BLOCK_END,
        '[skills]',
        'paths = []',
        ''
    ].join('\n');
    assert.deepEqual(parseToml(removeMarkedManagedBlocksFromToml(source)), parseToml(source));
});

test('quoted/escaped model keys and their nested tables are removed without touching adjacent configuration', () => {
    const source = [
        '["model" . "xora\\u002da"] # exact owned table',
        'note = """',
        '[skills]',
        '# not a real table boundary',
        '"""',
        "['model'.'xora-a'.'extra_headers']",
        'custom = "old"',
        "['model'.'user-model']",
        'model = "keep"',
        '[skills]',
        'paths = ["/shared"]',
        ''
    ].join('\n');
    const cleaned = removeModelTableFromToml(source, 'xora-a');
    const parsed = parseToml(cleaned);
    assert.deepEqual(parsed.model, { 'user-model': { model: 'keep' } });
    assert.deepEqual(parsed.skills.paths, ['/shared']);
    assert.doesNotMatch(cleaned, /not a real table boundary|custom =/);
});

test('scoped TOML value updates accept multiline Windows paths and retain comments and string bodies', () => {
    const source = [
        'disabled_mcp_servers = [',
        '  "camoufox-reverse",',
        '] # keep top-level comment',
        '["skills"]',
        String.raw`paths = ['C:\Users\tester\skills',`,
        String.raw`  'D:\team\skills'] # keep path comment`,
        'notes = """',
        '[mcp_servers.camoufox-reverse]',
        'enabled = false',
        '"""',
        '["mcp_servers"."camoufox-reverse"]',
        '"enabled" = false # keep toggle comment',
        'command = "node"',
        ''
    ].join('\r\n');
    let edited = setTomlValue(source, ['skills', 'paths'], ['C:\\Users\\tester\\skills', 'E:\\new skills']);
    edited = setTomlValue(edited, ['disabled_mcp_servers'], []);
    edited = setTomlValue(edited, ['mcp_servers', 'camoufox-reverse', 'enabled'], true);
    const parsed = parseToml(edited);
    assert.deepEqual(parsed.skills.paths, ['C:\\Users\\tester\\skills', 'E:\\new skills']);
    assert.deepEqual(parsed.disabled_mcp_servers, []);
    assert.equal(parsed.mcp_servers['camoufox-reverse'].enabled, true);
    assert.equal(parsed.skills.notes, parseToml(source).skills.notes);
    assert.match(edited, /# keep top-level comment/);
    assert.match(edited, /# keep path comment/);
    assert.match(edited, /# keep toggle comment/);
});

test('inline and dotted TOML settings can be updated without replacing sibling settings', () => {
    const source = [
        'skills = { paths = ["/old"], ignore = ["draft"], other = -0.0 } # inline user settings',
        '["mcp_servers"."camoufox-reverse"]',
        'env = { KEEP = "keep-value", TOKEN = "old" }',
        'command = "node"',
        'started = 2026-09-08T01:02:03Z',
        ''
    ].join('\n');
    let edited = setTomlValue(source, ['skills', 'paths'], ['/new']);
    edited = setTomlValue(edited, ['mcp_servers', 'camoufox-reverse', 'env', 'TOKEN'], '${BOUND_TOKEN}');
    edited = setTomlValue(edited, ['mcp_servers', 'camoufox-reverse', 'env', 'EXTRA'], 'new');
    const parsed = parseToml(edited);
    assert.deepEqual(parsed.skills, { paths: ['/new'], ignore: ['draft'], other: -0 });
    assert.deepEqual(parsed.mcp_servers['camoufox-reverse'].env, { KEEP: 'keep-value', TOKEN: '${BOUND_TOKEN}', EXTRA: 'new' });
    assert.match(edited, /# inline user settings/);
    assert.match(edited, /started = 2026-09-08T01:02:03Z/);
    const dotted = setTomlValue('skills.paths = ["/old"]\n[ui]\ntheme = "dark"\n', ['skills', 'disabled'], ['draft']);
    assert.deepEqual(parseToml(dotted).skills, { paths: ['/old'], disabled: ['draft'] });
});

test('unmanaged semantic guard rejects a provider edit that loses shared integration settings', () => {
    assert.throws(() => assertUnmanagedTomlPreserved(
        '[skills]\npaths=["/team"]\n[mcp_servers.shared]\ncommand="node"\n',
        '[model.xora-a]\nmodel="new"\n', ['xora-a']
    ), /would change shared Skills, MCP/);
});

test('saving and changing a relay preserves actual shared config and its recoverable backup', t => {
    for (const enclosed of [false, true]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-preserve-relay-config-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const registry = Object.create(ProviderRegistry.prototype);
        registry.grokHomePath = directory;
        registry.grokConfigPath = path.join(directory, 'config.toml');
        registry.metadataPath = path.join(directory, 'providers.json');
        registry.metadataLockPath = path.join(directory, '.providers.lock');
        registry.providerUpdatePath = path.join(directory, '.provider-update.json');
        registry.lockPath = path.join(directory, '.grok.lock');
        const secrets = new Map();
        registry.vault = {
            has: reference => secrets.has(reference),
            get: reference => secrets.get(reference),
            set: (reference, value) => secrets.set(reference, value),
            delete: reference => secrets.delete(reference)
        };
        const shared = [
            '# user-owned shared integration settings',
            'notes = """',
            MANAGED_BLOCK_START,
            '[model.xora-fake-in-string]',
            MANAGED_BLOCK_END,
            '"""',
            ...(enclosed ? [MANAGED_BLOCK_START, '[model.xora-obsolete]', 'model = "old"'] : []),
            '[skills]',
            String.raw`paths = ['C:\Users\tester\.codex\skills',`,
            String.raw` 'D:\team\skills'] # keep user paths`,
            '[mcp_servers."camoufox-reverse"]',
            'command = "node"',
            'args = ["camoufox-mcp.js"]',
            'env = { TOKEN = "${BOUND_MCP_TOKEN}" }',
            ...(enclosed ? [MANAGED_BLOCK_END] : []),
            '[ui]',
            'theme = "dark"',
            ''
        ].join('\n');
        fs.writeFileSync(registry.grokConfigPath, shared);
        const original = parseToml(shared);
        const first = customProvider();
        registry.save(first, 'fixture-only-api-key');
        registry.save({ ...first, baseUrl: 'https://api.ymocode.com/v1' }, 'replacement-fixture-key');
        const after = fs.readFileSync(registry.grokConfigPath, 'utf8');
        const parsed = parseToml(after);
        assert.deepEqual(parsed.skills, original.skills);
        assert.deepEqual(parsed.mcp_servers, original.mcp_servers);
        assert.deepEqual(parsed.ui, original.ui);
        assert.equal(parsed.notes, original.notes);
        assert.match(after, /# keep user paths/);
        assert.equal(parsed.model[first.id].base_url, 'https://api.ymocode.com/v1');
        assert.equal(parsed.model['xora-obsolete'], undefined);
        assert.equal(after.includes('fixture-only-api-key'), false);
        assert.equal(after.includes('replacement-fixture-key'), false);
        const backups = fs.readdirSync(directory).filter(name => name.startsWith('config.toml.xora-code.') && name.endsWith('.bak'));
        assert.equal(backups.some(name => fs.readFileSync(path.join(directory, name), 'utf8') === shared), true);
        registry.rewriteManagedBlock(registry.readMetadata());
        assert.equal(fs.readFileSync(registry.grokConfigPath, 'utf8'), after, 'an unchanged model catalog must not repeatedly rewrite shared config');
    }
});

test('custom Provider reasoning is opt-in, canonical and emitted with Grok Build 0.2.102 field names', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    const automatic = registry.validate(customProvider());
    assert.equal(automatic.reasoning, undefined);
    assert.doesNotMatch(registry.managedToml(automatic), /reasoning_effort/);

    const grok46Auto = registry.validate({
        ...customProvider(),
        model: 'grok-4.6'
    });
    assert.equal(grok46Auto.reasoning, undefined,
        'automatic capabilities remain derived instead of being persisted as an explicit user choice');
    const automaticModel = parseToml(registry.managedToml(grok46Auto)).model['xora-reasoning-test'];
    assert.equal(automaticModel.supports_reasoning_effort, true);
    assert.equal(automaticModel.reasoning_effort, 'high');
    assert.deepEqual(automaticModel.reasoning_efforts, [
        { value: 'low', label: '低', default: false },
        { value: 'medium', label: '中', default: false },
        { value: 'high', label: '高', default: true },
        { value: 'xhigh', label: '极高', default: false }
    ]);
    assert.equal(PROVIDER_REASONING_AUTO_POLICY_VERSION, 1);
    assert.equal(effectiveProviderReasoningConfiguration(grok46Auto, 2), undefined,
        'an unknown future policy version must fail closed instead of inheriting v1 inference');

    for (const input of [
        { ...customProvider(), model: 'Grok-4.6' },
        { ...customProvider(), model: 'grok-4.6-preview' },
        { ...customProvider('openai-chat-completions'), model: 'grok-4.6' },
        { ...customProvider('anthropic-messages'), model: 'grok-4.6' }
    ]) {
        const model = parseToml(registry.managedToml(registry.validate(input))).model['xora-reasoning-test'];
        assert.equal(model.supports_reasoning_effort, undefined,
            'automatic reasoning inference is exact, versioned and protocol-scoped');
    }

    for (const protocol of ['openai-responses', 'openai-chat-completions', 'anthropic-messages']) {
        const profile = registry.validate(customProvider(protocol, {
            options: ['xhigh', 'low', 'high'],
            defaultEffort: 'xhigh'
        }));
        assert.deepEqual(profile.reasoning, {
            options: ['low', 'high', 'xhigh'],
            defaultEffort: 'xhigh'
        });
        const toml = registry.managedToml(profile);
        const parsed = parseToml(toml);
        const model = parsed.model['xora-reasoning-test'];
        assert.equal(model.supports_reasoning_effort, true);
        assert.equal(model.reasoning_effort, 'xhigh');
        assert.deepEqual(model.reasoning_efforts, [
            { value: 'low', label: '低', default: false },
            { value: 'high', label: '高', default: false },
            { value: 'xhigh', label: '极高', default: true }
        ]);
    }

    const explicitGrok46 = registry.validate({
        ...customProvider(),
        model: 'grok-4.6',
        reasoning: { options: ['low', 'xhigh'], defaultEffort: 'xhigh' }
    });
    const explicitModel = parseToml(registry.managedToml(explicitGrok46)).model['xora-reasoning-test'];
    assert.equal(explicitModel.reasoning_effort, 'xhigh', 'explicit configuration must win over auto policy');
    assert.deepEqual(explicitModel.reasoning_efforts, [
        { value: 'low', label: '低', default: false },
        { value: 'xhigh', label: '极高', default: true }
    ]);
});

test('custom Provider reasoning rejects invalid and ambiguous defaults', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    assert.throws(() => registry.validate(customProvider('openai-responses', {
        options: [],
        defaultEffort: 'medium'
    })), /思考等级/);
    assert.throws(() => registry.validate(customProvider('openai-responses', {
        options: ['low', 'high'],
        defaultEffort: 'xhigh'
    })), /默认思考等级/);
    assert.throws(() => registry.validate(customProvider('openai-responses', {
        options: ['high', 'high'],
        defaultEffort: 'high'
    })), /思考等级选项/);
});
