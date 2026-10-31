import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration } from '../src/duration.js';

test('formats minutes and seconds', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(59), '59s');
    assert.equal(formatDuration(61), '1m 1s');
});
