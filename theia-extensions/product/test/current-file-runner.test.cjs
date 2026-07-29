// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCurrentFileRunnerPlan, toTerminalCommandArgs } = require('../lib/browser/current-file-runner');
const fs = require('node:fs');
const path = require('node:path');

test('Python 运行与测试保留中文和空格路径为独立参数', () => {
    const file = '/tmp/示例 项目/test_math.py';
    const plan = createCurrentFileRunnerPlan(file, 'posix');

    assert.equal(plan.language, 'Python');
    assert.deepEqual(plan.run.args, [file]);
    assert.deepEqual(toTerminalCommandArgs(plan.run), ['python3', file]);
    assert.deepEqual(plan.test.args, ['-m', 'pytest', file]);
});

test('Windows Python 使用 py launcher', () => {
    const file = 'C:\\work tree\\main.py';
    const plan = createCurrentFileRunnerPlan(file, 'windows');

    assert.equal(plan.run.executable, 'py');
    assert.deepEqual(plan.run.args, ['-3', file]);
});

test('JavaScript 与 MJS 使用 Node 和 Node Test', () => {
    for (const extension of ['js', 'mjs', 'cjs']) {
        const file = `/tmp/example.${extension}`;
        const plan = createCurrentFileRunnerPlan(file, 'posix');
        assert.equal(plan.run.executable, 'node');
        assert.deepEqual(plan.run.args, [file]);
        assert.deepEqual(plan.test.args, ['--test', file]);
    }
});

test('POSIX C 执行使用临时产物且不把源文件路径拼进脚本', () => {
    const file = '/tmp/project/a file.c';
    const plan = createCurrentFileRunnerPlan(file, 'posix');

    assert.equal(plan.language, 'C');
    assert.equal(plan.run.executable, 'sh');
    assert.equal(plan.run.args.at(-1), file);
    assert.doesNotMatch(plan.run.args[1], /a file\.c/);
    assert.match(plan.run.args[1], /TMPDIR/);
    assert.match(plan.test.args[1], /-Wall -Wextra/);
});

test('Windows C 执行由 PowerShell 安全接收源文件参数', () => {
    const file = 'C:\\work & test\\hello.c';
    const plan = createCurrentFileRunnerPlan(file, 'windows');

    assert.equal(plan.run.executable, 'powershell.exe');
    assert.equal(plan.run.args.at(-1), file);
    assert.doesNotMatch(plan.run.args.at(-2), /work & test/);
    assert.match(plan.run.args.at(-2), /Get-Command/);
});

test('Java、Go、Rust、Shell 与 TypeScript 均生成可见运行计划', () => {
    for (const file of ['Main.java', 'main.go', 'main.rs', 'check.sh', 'main.ts']) {
        const plan = createCurrentFileRunnerPlan(`/tmp/${file}`, 'posix');
        assert.ok(plan?.run, file);
        assert.ok(plan?.test, file);
    }
});

test('普通文档不会显示运行入口', () => {
    assert.equal(createCurrentFileRunnerPlan('/tmp/README.md', 'posix'), undefined);
    assert.equal(createCurrentFileRunnerPlan('/tmp/config.json', 'posix'), undefined);
});

test('终端工具栏提供明确的关闭当前终端入口', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/xora-file-runner-contribution.ts'), 'utf8');
    assert.match(source, /command: TerminalCommands\.KILL_TERMINAL\.id/);
    assert.match(source, /tooltip: '关闭终端'/);
    assert.match(source, /icon: codicon\('trash'\)/);
    assert.match(source, /isVisible: widget => widget instanceof TerminalWidget/);
});
