import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify, truncate, wordCount } from '../src/text.js';

test('slugify', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
    assert.equal(slugify('  Crème Brûlée  recipe '), 'creme-brulee-recipe');
    assert.equal(slugify('a--b__c'), 'a-b-c');
    assert.equal(slugify('!!!'), '');
});

test('truncate', () => {
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('the quick brown fox', 12), 'the quick…');
    assert.equal(truncate('abcdefghij', 5), 'abcd…');
    assert.equal(truncate('exactly ten', 11), 'exactly ten');
});

test('wordCount', () => {
    assert.equal(wordCount('one two  three'), 3);
    assert.equal(wordCount("it's 2026, isn't it?"), 6);
    assert.equal(wordCount('你好 world'), 3);
    assert.equal(wordCount(''), 0);
});
