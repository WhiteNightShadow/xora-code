// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { XoraTextReplacementContribution } = require('../lib/browser/xora-text-replacement-contribution');

test('简体中文信任弹窗不回退为英文', () => {
    const replacements = new XoraTextReplacementContribution().getReplacement('zh-cn');

    assert.equal(
        replacements['Do you trust the authors of the files in this folder?'],
        '是否信任此文件夹中的文件作者？'
    );
    assert.equal(replacements["No, I don't trust the authors"], '不信任，以受限模式打开');
    assert.equal(replacements['Yes, I trust the authors'], '信任并继续');
});

test('产品扩展在 i18n 预加载阶段注册文本替换', () => {
    const productPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert.equal(productPackage.theiaExtensions[0].frontendPreload, 'lib/browser/xora-product-preload-module');
});

test('其他 locale 不会被产品中文文案覆盖', () => {
    const contribution = new XoraTextReplacementContribution();
    assert.deepEqual(contribution.getReplacement('en'), {});
    assert.deepEqual(contribution.getReplacement('zh-tw'), {});
});
