// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function running(pid) {
    try {
        const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return state !== '' && !state.startsWith('Z');
    } catch (error) {
        if (error.status === 1) return false;
        throw error;
    }
}

async function untilStopped(pid, milliseconds = 3000) {
    const deadline = Date.now() + milliseconds;
    while (running(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    return !running(pid);
}

async function fixture(t) {
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xora-credential-watchdog-')));
    const helperScript = path.join(directory, 'helper.cjs');
    const parentScript = path.join(directory, 'parent.cjs');
    const watchdogModule = path.resolve(__dirname, '../scripts/credential-parent-watchdog.js');
    fs.writeFileSync(helperScript, `
'use strict';
const {startCredentialParentWatchdog}=require(process.argv[2]);
const watchdog=startCredentialParentWatchdog(()=>{
    if(process.connected)process.send({event:'monitor-failed'});
    process.exit(70);
});
watchdog.ready.then(()=>process.send({event:'ready',helper:process.pid})).catch(()=>{});
process.on('message',message=>{
    if(message==='block'){
        process.send({event:'blocking'},()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));
    }else if(message==='stop'){
        watchdog.stop();
        watchdog.stop();
        // stop is deliberately nonblocking; let the owned worker terminate
        // before closing the parent's lease as a simulated orderly shutdown.
        setTimeout(()=>process.send({event:'stopped'}),100);
    }else if(message==='ping'){
        process.send({event:'pong'});
    }else if(message==='quit'){
        watchdog.stop();
        process.exit(0);
    }
});
`);
    fs.writeFileSync(parentScript, `
'use strict';
const {fork}=require('node:child_process');
const helper=fork(process.argv[2],[process.argv[3]],{stdio:['ignore','ignore','ignore','ipc','pipe']});
helper.on('message',message=>{if(process.connected)process.send(message);});
helper.on('error',()=>{if(process.connected)process.send({event:'helper-error'});});
helper.on('close',(code,signal)=>{
    // Production likewise holds this descriptor until helper close.
    helper.stdio[4].destroy();
    if(process.connected)process.send({event:'helper-closed',code,signal},()=>process.exit(0));
    else process.exit(0);
});
process.on('message',message=>{
    if(message==='close-lease'){
        helper.stdio[4].destroy();
        process.send({event:'lease-closed'});
    }else helper.send(message);
});
`);
    const parent = fork(parentScript, [helperScript, watchdogModule], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const messages = [];
    const waiters = new Set();
    let helperPid;
    parent.on('message', message => {
        messages.push(message);
        if (message.event === 'ready') helperPid = message.helper;
        for (const notify of [...waiters]) notify();
    });
    function message(event) {
        return new Promise((resolve, reject) => {
            const inspect = () => {
                const found = messages.find(value => value.event === event);
                if (!found) return;
                clearTimeout(timer);
                waiters.delete(inspect);
                resolve(found);
            };
            const timer = setTimeout(() => {
                waiters.delete(inspect);
                reject(new Error('Owned fixture did not report ' + event + '; observed ' + messages.map(value => value.event).join(',')));
            }, 3000);
            waiters.add(inspect);
            inspect();
        });
    }
    t.after(async () => {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
        if (helperPid && !(await untilStopped(helperPid, 1000))) {
            // Test failure cleanup targets only our uniquely named fixture.
            try {
                const command = execFileSync('ps', ['-p', String(helperPid), '-o', 'command='], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
                });
                if (command.includes(helperScript)) process.kill(helperPid, 'SIGKILL');
            } catch { /* already gone */ }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await message('ready');
    return { parent, helperPid, messages, message };
}

test('parent lease watchdog kills only its helper after parent death while helper main thread is blocked', {
    skip: process.platform === 'win32', timeout: 8000
}, async t => {
    const f = await fixture(t);
    f.parent.send('block');
    await f.message('blocking');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(running(f.helperPid), true, 'fixture helper must be alive and blocked before parent death');
    const died = new Promise(resolve => f.parent.once('exit', resolve));
    assert.equal(f.parent.kill('SIGKILL'), true);
    await died;
    assert.equal(await untilStopped(f.helperPid), true, 'main-thread IPC disconnect cannot run; independent lease worker must terminate the helper');
    assert.equal(running(process.pid), true, 'watchdog must not signal its ancestor/test controller');
});

test('normal watchdog stop permits lease closure and a normal helper exit without SIGKILL', {
    skip: process.platform === 'win32', timeout: 8000
}, async t => {
    const f = await fixture(t);
    f.parent.send('stop');
    await f.message('stopped');
    f.parent.send('close-lease');
    await f.message('lease-closed');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(running(f.helperPid), true, 'stopped watchdog must not react to the closed lease');
    f.parent.send('ping');
    await f.message('pong');
    f.parent.send('quit');
    const result = await f.message('helper-closed');
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(f.messages.some(message => message.event === 'monitor-failed'), false);
});
