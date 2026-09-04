// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('About reads the packaged application version and never ships a stale fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/xora-about-dialog.tsx'), 'utf8');
    assert.match(source, /this\.applicationInfo\?\.version \?\? '未知'/);
    assert.doesNotMatch(source, /applicationInfo\?\.version \?\? '\d+\.\d+\.\d+'/);
});
