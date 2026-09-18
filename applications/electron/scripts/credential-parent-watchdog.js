// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const { Worker } = require('node:worker_threads');

// This runs on its own event loop, including while Keychain blocks the helper's
// main thread. The parent owns the other end of fd 4; its death closes the pipe.
// Never accept a PID or an executable from a credential request.
function watchParentLease() {
    const { parentPort } = require('node:worker_threads');
    const { Socket } = require('node:net');
    const lease = new Socket({ fd: 4, readable: true, writable: false });
    const parentGone = () => process.kill(process.pid, 'SIGKILL');
    lease.once('end', parentGone);
    lease.once('error', parentGone);
    lease.resume();
    parentPort.postMessage('ready');
}

function startCredentialParentWatchdog(onFailure) {
    const worker = new Worker(`(${watchParentLease.toString()})();`, { eval: true });
    let stopped = false;
    const ready = new Promise((resolve, reject) => {
        const fail = () => {
            if (stopped) return;
            reject(new Error('Credential parent monitor unavailable'));
            onFailure();
        };
        worker.once('message', message => message === 'ready' ? resolve() : fail());
        worker.once('error', fail);
        worker.once('exit', fail);
    });
    worker.unref();
    return {
        ready,
        stop() {
            if (stopped) return;
            stopped = true;
            void worker.terminate();
        }
    };
}

module.exports = { startCredentialParentWatchdog };
