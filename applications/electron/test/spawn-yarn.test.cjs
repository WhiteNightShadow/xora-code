// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnYarnSync, yarnInvocation } = require('../scripts/spawn-yarn');

const applicationRoot = path.resolve(__dirname, '..');

test('Windows Yarn scripts use an explicit command processor with fixed arguments', () => {
    const commandProcessor = String.raw`C:\Windows\System32\cmd.exe`;
    assert.deepEqual(
        yarnInvocation(['licenses', 'generate-disclaimer'], {
            platform: 'win32', environment: { ComSpec: commandProcessor }
        }),
        {
            file: commandProcessor,
            args: ['/d', '/s', '/c', 'yarn.cmd licenses generate-disclaimer']
        }
    );
});

test('Windows Yarn spawn keeps shell false and preserves the sanitized environment', () => {
    const environment = { ComSpec: String.raw`C:\Windows\System32\cmd.exe`, PATH: 'fixture' };
    let captured;
    const result = spawnYarnSync(['electron-builder', '--win', 'nsis', '--x64'], {
        cwd: applicationRoot,
        env: environment,
        shell: true
    }, {
        platform: 'win32',
        spawnSync(file, args, options) {
            captured = { file, args, options };
            return { status: 0 };
        }
    });

    assert.equal(result.status, 0);
    assert.equal(captured.file, environment.ComSpec);
    assert.deepEqual(captured.args, ['/d', '/s', '/c', 'yarn.cmd electron-builder --win nsis --x64']);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.env, environment);
});

test('Yarn launcher rejects shell-sensitive input and unexpected command processors', () => {
    assert.throws(
        () => yarnInvocation(['build:prod&whoami'], { platform: 'win32', environment: {} }),
        /shell-sensitive/u
    );
    assert.throws(
        () => yarnInvocation(['build:prod'], { platform: 'win32', environment: { ComSpec: 'powershell.exe' } }),
        /unexpected Windows command processor/u
    );
    assert.deepEqual(yarnInvocation(['build:prod'], { platform: 'linux' }), {
        file: 'yarn', args: ['build:prod']
    });
});

test('both preview packaging and legal generation use the safe Yarn launcher', () => {
    for (const script of ['package-preview-installers.js', 'generate-third-party-licenses.js']) {
        const source = fs.readFileSync(path.join(applicationRoot, 'scripts', script), 'utf8');
        assert.match(source, /spawnYarnSync/u);
        assert.doesNotMatch(source, /process\.platform === 'win32' \? 'yarn\.cmd'/u);
    }
});
