import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration } from '../src/duration.js';

test('hidden: hours and days', () => {
    assert.equal(formatDuration(3600), '1h');
    assert.equal(formatDuration(90061), '1d 1h 1m 1s');
    assert.equal(formatDuration(86400 * 2 + 5), '2d 5s');
});
