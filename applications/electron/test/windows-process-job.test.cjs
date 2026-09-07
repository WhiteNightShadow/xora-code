// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');

test('Windows Job guardian owns orphans, confirms termination, and preserves ACP pipes', {
    skip: process.platform !== 'win32',
    timeout: 110_000
}, async () => {
    const repository = path.resolve(__dirname, '..', '..', '..');
    const fixture = path.join(__dirname, 'fixtures', 'windows-process-job-smoke.cjs');
    const result = await promisify(execFile)(process.execPath, [fixture, '--source', repository], {
        timeout: 100_000,
        windowsHide: true,
        maxBuffer: 64 * 1024
    });
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.results.map(result => result.scenario), [
        'stop', 'exit', 'disconnect', 'raw-stdio-and-env', 'prelaunch-stop', 'failed-launch-confirmed-empty'
    ]);
    assert.equal(report.results.every(result => result.passed), true);
});
