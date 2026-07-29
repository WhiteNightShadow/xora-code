const assert = require('node:assert/strict');
const test = require('node:test');

const {
    detectSlashQuery,
    extractNamedResources,
    filterSlashCommands,
    hasDelimitedResourceReference,
    replaceSlashToken,
    resourceMenuItems,
    slashCommandsToMenuItems
} = require('../lib/browser/agent-slash-menu');

test('detectSlashQuery activates at start and after whitespace', () => {
    assert.deepEqual(detectSlashQuery('/file', 5), { start: 0, end: 5, query: 'file' });
    assert.deepEqual(detectSlashQuery('hello /mc', 9), { start: 6, end: 9, query: 'mc' });
    assert.equal(detectSlashQuery('https://x', 9), undefined);
    assert.equal(detectSlashQuery('path/to', 7), undefined);
    assert.equal(detectSlashQuery('/file more', 10), undefined);
});

test('filterSlashCommands matches trigger, label and aliases', () => {
    const files = filterSlashCommands('fi');
    assert.ok(files.some(item => item.id === 'file'));
    const skills = filterSlashCommands('技能');
    assert.ok(skills.some(item => item.id === 'skill'));
    const mcp = filterSlashCommands('mcp');
    assert.equal(mcp.length, 1);
    assert.equal(mcp[0].id, 'mcp');
});

test('slashCommandsToMenuItems preserves command ids', () => {
    const items = slashCommandsToMenuItems(filterSlashCommands(''));
    assert.ok(items.length >= 5);
    assert.ok(items.every(item => item.kind === 'command' && item.commandId));
});

test('replaceSlashToken inserts replacement with spacing', () => {
    const result = replaceSlashToken('先看 /file', { start: 3, end: 8, query: 'file' }, '@src/a.ts');
    assert.equal(result.text, '先看 @src/a.ts ');
    assert.equal(result.text.includes('/file'), false);
    const middle = replaceSlashToken('使用 /mcp继续', { start: 3, end: 7, query: 'mcp' }, 'docs');
    assert.equal(middle.text, '使用 docs 继续');
    assert.equal(hasDelimitedResourceReference(middle.text, 'docs'), true);
    assert.equal(hasDelimitedResourceReference('使用 docs继续', 'docs'), false);
});

test('extractNamedResources reads mcp and skill payloads', () => {
    const mcp = extractNamedResources({
        schemaVersion: 1,
        mcpServers: [
            { name: 'docs', transport: 'stdio' },
            { name: 'search', transport: 'http', status: 'healthy' }
        ]
    }, 'mcp');
    assert.deepEqual(mcp.map(item => item.name).sort(), ['docs', 'search']);

    const skills = extractNamedResources({
        skills: {
            effectiveSkills: [
                { name: 'review', path: '/tmp/review/SKILL.md' },
                { skillName: 'deploy', directory: '/tmp/deploy' },
                { name: 'disabled-review', path: '/tmp/disabled/SKILL.md', enabled: false }
            ]
        }
    }, 'skill');
    assert.ok(skills.some(item => item.name === 'review'));
    assert.ok(skills.some(item => item.name === 'deploy'));
    assert.equal(skills.some(item => item.name === 'disabled-review'), false);
});

test('resourceMenuItems appends manage action', () => {
    const items = resourceMenuItems('mcp', [{ name: 'docs', detail: 'stdio' }]);
    assert.equal(items[0].insertText, 'docs');
    assert.equal(items[0].resourceKind, 'mcp');
    assert.doesNotMatch(items[0].insertText, /优先使用|请使用/);
    assert.equal(items.at(-1).commandId, 'settings');
});

test('schema-v2 MCP menu includes configured enabled servers before and after session load', () => {
    const mcp = extractNamedResources({
        schemaVersion: 2,
        mcpServers: [
            { name: 'ready-browser', transport: 'stdio', runtimeState: 'loaded', callable: true, selectable: true },
            { name: 'draft-browser', transport: 'http', runtimeState: 'not-loaded', callable: false, selectable: true },
            { name: 'disabled', transport: 'stdio', runtimeState: 'disabled', callable: false, selectable: false },
            { name: 'compat-only', transport: 'stdio', importRequired: true, callable: false, selectable: false }
        ]
    }, 'mcp');
    assert.deepEqual(mcp.map(item => item.name), ['draft-browser', 'ready-browser']);
    assert.equal(mcp.find(item => item.name === 'draft-browser').detail, '发送后自动加载');
    assert.equal(mcp.find(item => item.name === 'ready-browser').detail, '当前会话已加载');
});
