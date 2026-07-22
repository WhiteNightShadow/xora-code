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
