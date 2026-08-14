const assert = require('node:assert/strict');
const test = require('node:test');
const { parse: parseToml } = require('smol-toml');

const {
    MANAGED_BLOCK_END,
    MANAGED_BLOCK_START,
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
