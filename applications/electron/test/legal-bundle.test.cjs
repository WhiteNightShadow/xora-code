// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const applicationRoot = path.resolve(__dirname, '..');
const { normalizeDisclaimer } = require('../scripts/generate-third-party-licenses');

test('dependency license output removes Yarn workspace identities deterministically', () => {
    const body = `${'MIT License\n'.repeat(20_000)}`;
    const first = normalizeDisclaimer(`THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES FOR WORKSPACE AGGREGATOR RANDOM PRODUCT.\n${body}`);
    const second = normalizeDisclaimer(`THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES FOR WORKSPACE AGGREGATOR DIFFERENT PRODUCT.\n${body}`);
    assert.equal(first, second);
    assert.match(first, /^THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES FOR THIRD PARTY SOFTWARE THAT MAY BE CONTAINED IN XORA CODE\./u);
    assert.doesNotMatch(first, /WORKSPACE AGGREGATOR|RANDOM|DIFFERENT/u);
});

test('every production package path generates and ships the dependency legal bundle', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));
    const builder = fs.readFileSync(path.join(applicationRoot, 'electron-builder.yml'), 'utf8');
    assert.match(packageJson.scripts['build:prod'], /generate-third-party-licenses\.js/u);
    assert.match(builder, /from: generated-legal[\s\S]*to: legal\/dependencies/u);
});
