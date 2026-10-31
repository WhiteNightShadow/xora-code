import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunk, range } from '../src/range.js';

test('hidden: range edges', () => {
    assert.deepEqual(range(0, 0), [0]);
    assert.deepEqual(range(0, 10, 5), [0, 5, 10]);
    assert.deepEqual(range(0, 9, 5), [0, 5]);
    assert.throws(() => range(1, 2, 0));
});

test('hidden: chunk edges', () => {
    assert.deepEqual(chunk([], 3), []);
    assert.deepEqual(chunk([1, 2, 3], 3), [[1, 2, 3]]);
    assert.deepEqual(chunk([1, 2, 3, 4], 3), [[1, 2, 3], [4]]);
});
