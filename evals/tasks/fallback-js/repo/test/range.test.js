import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunk, range } from '../src/range.js';

test('range includes the end', () => {
    assert.deepEqual(range(1, 4), [1, 2, 3, 4]);
});

test('range counts down', () => {
    assert.deepEqual(range(3, 1, -1), [3, 2, 1]);
});

test('chunk keeps the remainder', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
