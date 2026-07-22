// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    applyXoraWindowChrome,
    xoraTitleBarStyle
} = require('../lib/electron-main/xora-window-chrome');

test('macOS 隐藏原生标题栏但保留交通灯', () => {
    const options = applyXoraWindowChrome({ frame: false, titleBarStyle: 'default' }, 'darwin');

    assert.equal(options.frame, true);
    assert.equal(options.titleBarStyle, 'hiddenInset');
    assert.deepEqual(options.trafficLightPosition, { x: 14, y: 12 });
    assert.equal(options.transparent, false);
    assert.equal(xoraTitleBarStyle('darwin'), 'native');
});

test('Windows 与 Linux 强制使用带系统操作能力的无边框窗口', () => {
    for (const platform of ['win32', 'linux']) {
        const options = applyXoraWindowChrome({ frame: true, titleBarStyle: 'default' }, platform);

        assert.equal(options.frame, false);
        assert.equal(options.titleBarStyle, 'hidden');
        assert.equal(options.thickFrame, true);
        assert.equal(options.hasShadow, true);
        assert.equal(xoraTitleBarStyle(platform), 'custom');
    }
});

test('产品扩展注册主进程窗口策略并把现有标题表面作为安全拖拽区', () => {
    const productPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const css = fs.readFileSync(path.join(__dirname, '../src/browser/style/xora-code.css'), 'utf8');
    const shellContribution = fs.readFileSync(path.join(__dirname, '../src/browser/xora-shell-contribution.ts'), 'utf8');

    assert.equal(productPackage.theiaExtensions[0].electronMain, 'lib/electron-main/xora-electron-main-module');
    assert.match(css, /body\.xora-electron-frameless #main-toolbar/);
    assert.match(css, /-webkit-app-region:\s*drag/);
    assert.match(css, /-webkit-app-region:\s*no-drag/);
    assert.match(css, /xora-platform-darwin/);
    assert.match(css, /\.theia-sidepanel-toolbar/);
    assert.match(css, /#theia-main-content-panel \.lm-TabBar/);
    assert.match(css, /#theia-main-content-panel:not\(:has\(\.lm-TabBar\)\)::before/);
    assert.doesNotMatch(css, /#xora-window-drag-handle/);
    assert.doesNotMatch(shellContribution, /createElement\(['"]div['"]\)/);
});

test('macOS Explorer 为交通灯保留安全边距', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/browser/style/xora-code.css'), 'utf8');

    assert.match(css, /xora-platform-darwin \.theia-sidepanel-toolbar\.theia-left-side-panel/);
    assert.match(css, /\.theia-sidepanel-title[\s\S]*?margin-left:\s*70px/);
    assert.match(css, /min-height:\s*32px/);
});

test('桌面外壳只移除次要 chrome，保留菜单栏、项目树、终端和窗口控制', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/browser/style/xora-code.css'), 'utf8');
    const shellContribution = fs.readFileSync(path.join(__dirname, '../src/browser/xora-shell-contribution.ts'), 'utf8');

    assert.match(shellContribution, /xora-compact-workbench/);
    assert.match(css, /xora-compact-workbench[\s\S]*?#main-toolbar[\s\S]*?display:\s*none\s*!important/);
    assert.match(css, /#theia-left-content-panel\s*>\s*\.theia-app-sidebar-container/);
    assert.match(css, /xora-compact-workbench[\s\S]*?#theia-statusBar[\s\S]*?display:\s*none\s*!important/);
    // Windows/Linux must keep the application MenuBar visible (not hide the whole top panel).
    assert.match(css, /#theia-top-panel\s*>\s*:not\(#theia-drag-panel\):not\(#window-controls\):not\(\.p-MenuBar\):not\(\.lm-MenuBar\)/);
    assert.match(css, /xora-platform-darwin #main-toolbar[\s\S]*?min-height:\s*30px/);
    assert.doesNotMatch(css, /#theia-bottom-(?:content|split)-panel[^{]*\{[^}]*display:\s*none/);
});

test('工作台就绪后不会继续等待默认的八百毫秒加载层动画', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/browser/style/xora-code.css'), 'utf8');

    assert.match(css, /xora-compact-workbench \.theia-preload[\s\S]*?transition-duration:\s*120ms/);
});

test('资源管理器只保留项目树并清理旧布局中的打开编辑器列表', () => {
    const productPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const moduleSource = fs.readFileSync(path.join(__dirname, '../src/browser/xora-product-frontend-module.ts'), 'utf8');
    const factorySource = fs.readFileSync(path.join(__dirname, '../src/browser/xora-navigator-widget-factory.ts'), 'utf8');
    const shellSource = fs.readFileSync(path.join(__dirname, '../src/browser/xora-shell-contribution.ts'), 'utf8');

    assert.equal(productPackage.dependencies['@theia/navigator'], '1.73.1');
    assert.match(moduleSource, /rebind\(NavigatorWidgetFactory\)\.to\(XoraNavigatorWidgetFactory\)/);
    assert.match(factorySource, /getOrCreateWidget\(FILE_NAVIGATOR_ID\)/);
    assert.doesNotMatch(factorySource, /OpenEditorsWidget/);
    assert.match(shellSource, /explorer\.removeWidget\(openEditors\)/);
});

test('切换目录或恢复旧布局后项目文件树仍保持可见', () => {
    const moduleSource = fs.readFileSync(path.join(__dirname, '../src/browser/xora-product-frontend-module.ts'), 'utf8');
    const factorySource = fs.readFileSync(path.join(__dirname, '../src/browser/xora-navigator-widget-factory.ts'), 'utf8');
    const explorerSource = fs.readFileSync(path.join(__dirname, '../src/browser/xora-explorer-contribution.ts'), 'utf8');

    assert.match(moduleSource, /FrontendApplicationContribution\)\.toService\(XoraExplorerContribution\)/);
    assert.match(factorySource, /closeable:\s*false/);
    assert.match(explorerSource, /onDidInitializeLayout/);
    assert.match(explorerSource, /onWorkspaceChanged/);
    assert.match(explorerSource, /tryGetRoots\(\)/);
    assert.match(explorerSource, /openView\(\{\s*activate:\s*false,\s*reveal:\s*true\s*\}\)/);
    assert.match(explorerSource, /explorer\?\.setTitleOptions/);
    assert.doesNotMatch(explorerSource, /activate:\s*true/);
    assert.doesNotMatch(explorerSource, /await\s+this\.workspaceService\.(?:ready|roots)/);
});
