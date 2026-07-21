// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SAFE_YARN_ARGUMENT = /^[A-Za-z0-9@._/:=+-]+$/u;

function yarnInvocation(args, runtime = {}) {
    if (!Array.isArray(args) || args.length === 0 || args.some(argument => typeof argument !== 'string' || !SAFE_YARN_ARGUMENT.test(argument))) {
        throw new Error('Refusing to pass a dynamic or shell-sensitive argument to Yarn');
    }

    const platform = runtime.platform || process.platform;
    if (platform !== 'win32') return { file: 'yarn', args: [...args] };

    const environment = runtime.environment || process.env;
    const commandProcessor = environment.ComSpec || environment.COMSPEC || 'cmd.exe';
    if (path.win32.basename(commandProcessor).toLowerCase() !== 'cmd.exe') {
        throw new Error('Refusing to launch an unexpected Windows command processor');
    }
    return {
        file: commandProcessor,
        args: ['/d', '/s', '/c', ['yarn.cmd', ...args].join(' ')]
    };
}

function spawnYarnSync(args, options = {}, runtime = {}) {
    const environment = runtime.environment || options.env || process.env;
    const invocation = yarnInvocation(args, { ...runtime, environment });
    const spawn = runtime.spawnSync || spawnSync;
    return spawn(invocation.file, invocation.args, {
        ...options,
        env: environment,
        shell: false
    });
}

module.exports = { SAFE_YARN_ARGUMENT, spawnYarnSync, yarnInvocation };
