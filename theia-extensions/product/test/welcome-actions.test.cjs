// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    WelcomeCommandIds,
    WELCOME_WORKSPACE_ACTIONS,
    shouldShowWelcome
} = require('../lib/browser/xora-welcome-actions');

test('中文开始页提供 Agent 与项目入口', () => {
    const workspaceActions = new Map(WELCOME_WORKSPACE_ACTIONS.map(action => [action.title, action]));
    assert.equal(workspaceActions.get('打开项目').commandId, WelcomeCommandIds.openFolder);
    assert.equal(workspaceActions.get('打开 Agent').commandId, WelcomeCommandIds.openAgent);
    assert.equal(workspaceActions.get('打开 Agent 设置').commandId, WelcomeCommandIds.openAgentManagement);
});

test('Xora Code 使用统一的命令与欢迎页标识', () => {
    assert.equal(WelcomeCommandIds.openAgent, 'xora-code.agent.open');
    assert.equal(WelcomeCommandIds.openAgentManagement, 'xora-code.agent.management.open');
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/xora-welcome-widget.tsx'), 'utf8');
    assert.match(source, /开始使用 Xora Code/);
    assert.doesNotMatch(source, /WhiteNight Code|whitenight-code/);
});

test('仅空窗口显示开始页', () => {
    assert.equal(shouldShowWelcome(0), true);
    assert.equal(shouldShowWelcome(1), false);
    assert.equal(shouldShowWelcome(3), false);
});

test('开始页只提供 Grok 订阅与自定义模型入口', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/xora-welcome-widget.tsx'), 'utf8');
    assert.match(source, /Grok 订阅/);
    assert.match(source, /自定义 API 与模型/);
    assert.doesNotMatch(source, /renderXaiApiKey|xora-xai-api-key|输入 API Key/);
});

test('带项目启动不在布局关键路径等待文件树聚焦', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/xora-welcome-contribution.ts'), 'utf8');
    const initializeStart = source.indexOf('async initializeLayout');
    const initializeEnd = source.indexOf('onStart(', initializeStart);
    assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
    assert.doesNotMatch(source.slice(initializeStart, initializeEnd), /focusExplorer/);
});
