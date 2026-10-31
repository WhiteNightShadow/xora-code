import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify, truncate, wordCount } from '../src/text.js';

test('hidden: slugify', () => {
    assert.equal(slugify('Ünïcödé Ünder'), 'unicode-under');
    assert.equal(slugify('2026 Plan v2'), '2026-plan-v2');
});

test('hidden: truncate', () => {
    assert.equal(truncate('hello world', 6), 'hello…');
    assert.ok(truncate('a very long sentence indeed', 9).length <= 9);
});

test('hidden: wordCount', () => {
    assert.equal(wordCount('中文分词'), 4);
    assert.equal(wordCount('  '), 0);
});
