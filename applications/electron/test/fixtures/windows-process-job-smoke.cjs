'use strict';
// Node 24 on Windows: node windows-process-job-smoke.cjs --source <repo root>
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sourceIndex = process.argv.indexOf('--source');
const source = sourceIndex >= 0 ? path.resolve(process.argv[sourceIndex + 1]) : process.cwd();
const script = path.join(source, 'applications/electron/scripts/windows-process-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, milliseconds = 7000) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) { if (predicate()) return; await delay(30); }
    throw new Error('fixture-timeout');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function guardian(request, options = {}) {
    const pipe = `\\\\.\\pipe\\xora-job-smoke-${crypto.randomUUID()}`;
    const token = crypto.randomBytes(32).toString('hex');
    let socket;
    let received = '';
    const packets = [];
    let exit;
    const stdout = [];
    const stderr = [];
    const server = net.createServer(connection => {
        socket = connection;
        connection.setEncoding('utf8');
        connection.on('error', () => undefined);
        connection.on('data', data => {
            received += data;
            while (received.includes('\n')) {
                const end = received.indexOf('\n');
                const message = JSON.parse(received.slice(0, end));
                received = received.slice(end + 1);
                packets.push(message);
                if (message.type === 'hello') {
                    assert.equal(message.token, token);
                    connection.write(JSON.stringify(request) + '\n');
                }
            }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        env: { ...process.env, ...options.environment, XORA_WINDOWS_JOB_PIPE: pipe, XORA_WINDOWS_JOB_TOKEN: token },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => stderr.push(data));
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    child.on('error', () => { exit = { code: -1, signal: null }; });
    const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 18000);
    try {
        await until(() => packets.some(message => message.type === 'started' || message.type === 'terminated') || exit, 14000);
        if (exit && !packets.some(message => message.type === 'terminated')) {
            throw new Error('guardian-exited-before-terminal-proof');
        }
    } catch (error) {
        clearTimeout(watchdog);
        socket?.destroy();
        try { child.kill('SIGKILL'); } catch {}
        server.close();
        throw error;
    }
    return {
        child, packets, stdout, stderr,
        stop: () => socket.write('{"type":"stop"}\n'),
        disconnect: () => socket.destroy(),
        wait: async () => {
            await until(() => exit, 7000);
            assert.equal(exit.signal, null);
            return exit;
        },
        close: async () => {
            clearTimeout(watchdog);
            socket?.destroy();
            if (!exit) { try { child.kill('SIGKILL'); } catch {} await until(() => exit, 2000).catch(() => {}); }
            server.close();
        }
    };
}

(async () => {
    if (process.platform !== 'win32') throw new Error('windows-required');
    const temporaryBase = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-job-smoke-'));
    const temporary = path.join(temporaryBase, 'workspace space 中文');
    fs.mkdirSync(temporary);
    const results = [];
    const worker = path.join(temporary, 'child.cjs');
    const leader = path.join(temporary, 'leader.ps1');
    fs.writeFileSync(worker, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
    fs.writeFileSync(leader, `param([string]$Node,[string]$Worker,[string]$ChildPid,[string]$Mode)\n$ErrorActionPreference='Stop'\n$p=New-Object System.Diagnostics.Process\n$p.StartInfo.FileName=$Node\n$p.StartInfo.Arguments='"'+$Worker+'" "'+$ChildPid+'"'\n$p.StartInfo.UseShellExecute=$false\n$p.StartInfo.CreateNoWindow=$true\n[void]$p.Start()\nwhile (-not (Test-Path -LiteralPath $ChildPid)) { Start-Sleep -Milliseconds 20 }\nif ($Mode -eq 'exit') { exit 0 }\nwhile ($true) { Start-Sleep -Milliseconds 100 }\n`);
    try {
        for (const mode of ['stop', 'exit', 'disconnect']) {
            const childPid = path.join(temporary, `pid-${mode}.txt`);
            const run = await guardian({
                type: 'launch', binary: powershell, cwd: temporary,
                args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', leader,
                    process.execPath, worker, childPid, mode === 'exit' ? 'exit' : 'stay']
            });
            try {
                await until(() => fs.existsSync(childPid));
                const pid = Number(fs.readFileSync(childPid, 'utf8'));
                if (mode !== 'exit') assert.equal(alive(pid), true);
                if (mode === 'stop') run.stop();
                if (mode === 'disconnect') run.disconnect();
                await run.wait();
                await until(() => !alive(pid));
                const terminal = run.packets.find(message => message.type === 'terminated');
                if (mode !== 'disconnect') {
                    assert.ok(terminal);
                    assert.equal(terminal.reason, mode === 'stop' ? 'stop' : 'exit');
                    assert.equal(run.packets.some(message => message.type === 'error'), false);
                }
                results.push({ scenario: mode, passed: true, descendantAlive: false, terminalConfirmed: !!terminal });
            } finally { await run.close(); }
        }
        const echo = path.join(temporary, 'echo.cjs');
        const envReport = path.join(temporary, 'env.json');
        fs.writeFileSync(echo, `const fs=require('node:fs');const crypto=require('node:crypto');fs.writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),controlAbsent:!process.env.XORA_WINDOWS_JOB_PIPE&&!process.env.XORA_WINDOWS_JOB_TOKEN,secretHash:crypto.createHash('sha256').update(process.env.XORA_TEST_SECRET).digest('hex')}));process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.stderr.write('stderr-raw-check'));\n`);
        const secret = crypto.randomBytes(32).toString('base64url');
        const extraArguments = ['plain', '', 'space value', 'quote"value', 'C:\\ends with\\', '\\\\"'];
        const payload = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","text":"中文"}\n'), Buffer.from([0, 255, 13, 10]), crypto.randomBytes(100)]);
        const run = await guardian({ type: 'launch', binary: process.execPath, cwd: temporary, args: [echo, envReport, ...extraArguments] }, { environment: { XORA_TEST_SECRET: secret } });
        try {
            run.child.stdin.end(payload);
            await run.wait();
            assert.deepEqual(Buffer.concat(run.stdout), payload);
            assert.equal(Buffer.concat(run.stderr).toString(), 'stderr-raw-check');
            const environment = JSON.parse(fs.readFileSync(envReport, 'utf8'));
            assert.deepEqual(environment.args, extraArguments);
            assert.equal(environment.controlAbsent, true);
            assert.equal(environment.secretHash, crypto.createHash('sha256').update(secret).digest('hex'));
            assert.equal(run.packets.some(message => message.type === 'terminated' && message.exitCode === 0), true);
            results.push({ scenario: 'raw-stdio-and-env', passed: true });
        } finally { await run.close(); }

        const stopped = await guardian({ type: 'stop' });
        try {
            await stopped.wait();
            assert.equal(stopped.packets.some(message => message.type === 'started'), false);
            assert.equal(stopped.packets.some(message => message.type === 'terminated' && message.reason === 'stop'), true);
            results.push({ scenario: 'prelaunch-stop', passed: true });
        } finally { await stopped.close(); }
        const failed = await guardian({ type: 'launch', binary: path.join(temporary, 'missing.exe'), args: [], cwd: temporary });
        try {
            await failed.wait();
            assert.equal(failed.packets.some(message => message.type === 'started'), false);
            assert.equal(failed.packets.some(message => message.type === 'error' && message.code === 'sidecar-create-failed'), true);
            assert.equal(failed.packets.some(message => message.type === 'terminated' && message.reason === 'error'), true);
            results.push({ scenario: 'failed-launch-confirmed-empty', passed: true });
        } finally { await failed.close(); }
        process.stdout.write(JSON.stringify({ status: 'passed', results }) + '\n');
    } finally { await fs.promises.rm(temporaryBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch(error => {
    process.stdout.write(JSON.stringify({ status: 'failed', code: error.message && /^[a-z-]{1,80}$/.test(error.message) ? error.message : 'fixture-assertion-failed' }) + '\n');
    process.exitCode = 1;
});
