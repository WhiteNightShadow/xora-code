const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');

const FAKE_KEY = 'xora-sidecar-contract-not-a-real-key';

function killProcessTree(child) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
}

function deadline(milliseconds, message) {
    return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref?.();
    });
}

test('pinned Grok sidecar honors [features].remote_fetch=false before ACP initialize', {
    timeout: 15_000
}, async t => {
    const executable = process.platform === 'win32' ? 'grok.exe' : 'grok';
    const binary = path.resolve(__dirname, '../../../resources/sidecars/grok', executable);
    if (!fs.existsSync(binary)) {
        t.skip(`packaged sidecar is not present at ${binary}`);
        return;
    }
    const version = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true
    });
    if (version.status !== 0 || !/grok 0\.2\.102\b/.test(version.stdout ?? '')) {
        t.skip('the checked-out sidecar cannot execute on this host');
        return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-sidecar-remote-fetch-'));
    const home = path.join(root, '.grok');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });

    let catalogRequests = 0;
    const modelServer = createServer((_request, _response) => {
        // Intentionally never answer. With the correct feature gate, Grok must
        // not contact this endpoint at all during ACP initialization.
        catalogRequests += 1;
    });
    await new Promise((resolve, reject) => {
        modelServer.once('error', reject);
        modelServer.listen(0, '127.0.0.1', resolve);
    });
    const address = modelServer.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    fs.writeFileSync(path.join(home, 'config.toml'), [
        '[features]',
        'remote_fetch = false',
        '',
        '[model."xora-contract"]',
        'model = "grok-contract"',
        `base_url = ${JSON.stringify(baseUrl)}`,
        'name = "Xora contract"',
        'api_backend = "responses"',
        'context_window = 1000000',
        'env_key = "XORA_CONTRACT_API_KEY"',
        ''
    ].join('\n'), { mode: 0o600 });

    const child = spawn(binary, [
        '--no-auto-update', '--cwd', workspace, 'agent', '--no-leader', 'stdio'
    ], {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            GROK_HOME: home,
            GROK_AUTH_PATH: path.join(root, 'missing-auth.json'),
            XAI_API_KEY: FAKE_KEY,
            XORA_CONTRACT_API_KEY: FAKE_KEY,
            GROK_XAI_API_BASE_URL: baseUrl,
            XDG_CONFIG_HOME: path.join(root, '.config'),
            XDG_CACHE_HOME: path.join(root, '.cache'),
            DISABLE_TELEMETRY: '1',
            NO_COLOR: '1'
        }
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
        stderr = `${stderr}${chunk}`.slice(-8_192).split(FAKE_KEY).join('[REDACTED]');
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const initialized = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            reject(new Error(`sidecar exited before initialize (code ${code}, signal ${signal})`));
        });
        lines.on('line', line => {
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                reject(new Error(`non-JSON ACP stdout: ${line.slice(0, 200)}`));
                return;
            }
            if (message?.id !== 1) return;
            if (message.error) reject(new Error(`initialize failed: ${JSON.stringify(message.error)}`));
            else resolve(message.result);
        });
    });

    const startedAt = Date.now();
    try {
        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false
                },
                clientInfo: { name: 'Xora remote-fetch contract', version: '0.1.0' },
                _meta: {
                    startupHints: {
                        nonInteractive: true,
                        skipGitStatus: true,
                        skipProjectLayout: true
                    }
                }
            }
        })}\n`);
        const result = await Promise.race([
            initialized,
            deadline(8_000, `ACP initialize contacted the blackholed catalog; stderr: ${stderr}`)
        ]);
        assert.ok(result && Array.isArray(result.authMethods));
        assert.equal(catalogRequests, 0, 'remote model catalog must not be requested during initialize');
        assert.ok(Date.now() - startedAt < 8_000, 'initialize must finish before the blackhole deadline');
    } finally {
        lines.close();
        try { child.stdin.end(); } catch { /* continue cleanup */ }
        killProcessTree(child);
        await Promise.race([exited, deadline(3_000, 'sidecar process-tree cleanup timed out')]);
        modelServer.closeAllConnections?.();
        await new Promise(resolve => modelServer.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
