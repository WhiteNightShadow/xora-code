const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RuntimeMcpRegistry } = require('../lib/electron-main/runtime-mcp-registry');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-runtime-mcp-'));
    const grokHome = path.join(root, 'grok-home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(grokHome, { recursive: true });
    fs.mkdirSync(path.join(workspace, '.grok'), { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return {
        grokHome,
        workspace,
        registry: new RuntimeMcpRegistry({ grokHome }),
        user(contents) {
            fs.writeFileSync(path.join(grokHome, 'config.toml'), `${contents.trim()}\n`);
        },
        project(contents) {
            fs.writeFileSync(path.join(workspace, '.grok', 'config.toml'), `${contents.trim()}\n`);
        }
    };
}

test('project MCP entries replace user entries and disabled servers are omitted', t => {
    const files = fixture(t);
    files.user([
        '[mcp_servers.user-only]',
        'command = "${NODE_BIN}"',
        'args = ["--mode", "${MODE:-safe}"]',
        'env = { ZED = "${UNSET:-fallback}", TOKEN = "${MCP_TOKEN}" }',
        '',
        '[mcp_servers.shared]',
        'command = "user-command"',
        'args = ["user-argument"]',
        '',
        '[mcp_servers.disable-me]',
        'command = "user-disabled-by-project"'
    ].join('\n'));
    files.project([
        '[mcp_servers.shared]',
        'transport_type = "sse"',
        'url = "${SHARED_URL}"',
        'headers = { "X-Token" = "${MCP_TOKEN}" }',
        '',
        '[mcp_servers.disable-me]',
        'enabled = false',
        '',
        '[mcp_servers.locally-off]',
        'disabled = true'
    ].join('\n'));

    const result = files.registry.resolve(files.workspace, {
        NODE_BIN: '/opt/node',
        MCP_TOKEN: 'runtime-secret',
        SHARED_URL: 'https://mcp.example.test/sse'
    });

    assert.deepEqual(result.mcpServers, [{
        name: 'shared',
        type: 'sse',
        url: 'https://mcp.example.test/sse',
        headers: [{ name: 'X-Token', value: 'runtime-secret' }]
    }, {
        name: 'user-only',
        command: '/opt/node',
        args: ['--mode', 'safe'],
        env: [
            { name: 'TOKEN', value: 'runtime-secret' },
            { name: 'ZED', value: 'fallback' }
        ]
    }]);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.configuredNames, ['disable-me', 'locally-off', 'shared', 'user-only']);
    assert.deepEqual(result.enabledNames, ['shared', 'user-only']);
    assert.deepEqual(new Set(result.redactionValues), new Set([
        '/opt/node',
        'fallback',
        'runtime-secret',
        'https://mcp.example.test/sse'
    ]));
    assert.doesNotMatch(JSON.stringify({
        fingerprint: result.fingerprint,
        configuredNames: result.configuredNames,
        enabledNames: result.enabledNames
    }), /runtime-secret/, 'renderer-safe projection must not contain resolved secrets');
    assert.equal('type' in result.mcpServers[1], false, 'ACP stdio must omit the type discriminator');
});

test('top-level disabled_mcp_servers is honored across user and project sources', t => {
    const files = fixture(t);
    files.user([
        'disabled_mcp_servers = ["global-off"]',
        '',
        '[mcp_servers.global-off]',
        'command = "node"',
        '',
        '[mcp_servers.project-off]',
        'command = "node"',
        '',
        '[mcp_servers.enabled]',
        'command = "node"'
    ].join('\n'));
    files.project([
        'disabled_mcp_servers = ["project-off"]',
        '',
        '[mcp_servers.global-off]',
        'command = "project-command"',
        'enabled = true'
    ].join('\n'));

    const result = files.registry.resolve(files.workspace, {});
    assert.deepEqual(result.configuredNames, ['enabled', 'global-off', 'project-off']);
    assert.deepEqual(result.enabledNames, ['enabled']);
    assert.deepEqual(result.mcpServers, [{ name: 'enabled', command: 'node', args: [], env: [] }]);
});

test('invalid disabled_mcp_servers values fail closed', t => {
    const files = fixture(t);
    files.user('disabled_mcp_servers = ["unsafe.name"]');
    assert.throws(
        () => files.registry.resolve(files.workspace, {}),
        /contains an unsafe server name/
    );
});

test('HTTP and SSE descriptors use header arrays and bearer token references', t => {
    const files = fixture(t);
    files.user([
        '[mcp_servers.http-api]',
        'url = "https://api.example.test/${ROUTE:-mcp}"',
        'headers = { "X-Client" = "xora", "X-Api-Key" = "${API_KEY}" }',
        'bearer_token_env_var = "BEARER_TOKEN"',
        '',
        '[mcp_servers.sse-api]',
        'type = "sse"',
        'url = "http://127.0.0.1:8787/sse"'
    ].join('\n'));

    const result = files.registry.resolve(files.workspace, {
        API_KEY: 'api-secret',
        BEARER_TOKEN: 'bearer-secret'
    });

    assert.deepEqual(result.mcpServers[0], {
        name: 'http-api',
        type: 'http',
        url: 'https://api.example.test/mcp',
        headers: [
            { name: 'Authorization', value: 'Bearer bearer-secret' },
            { name: 'X-Api-Key', value: 'api-secret' },
            { name: 'X-Client', value: 'xora' }
        ]
    });
    assert.deepEqual(result.mcpServers[1], {
        name: 'sse-api',
        type: 'sse',
        url: 'http://127.0.0.1:8787/sse',
        headers: []
    });
    assert.deepEqual(new Set(result.redactionValues), new Set([
        'api-secret',
        'xora',
        'bearer-secret',
        'Bearer bearer-secret'
    ]));
    assert.equal('env' in result.mcpServers[0], false);
});

test('redaction values include template sources but not ordinary command, URL, or argument text', t => {
    const files = fixture(t);
    files.user([
        '[mcp_servers.local]',
        'command = "node"',
        'args = ["--credential", "${ARG_SECRET}", "ordinary-argument"]',
        'env = { LITERAL_SECRET = "literal-env-secret" }',
        '',
        '[mcp_servers.remote]',
        'url = "https://mcp.example.test/${ROUTE_SECRET}"',
        'headers = { "X-Literal" = "literal-header-secret" }'
    ].join('\n'));

    const result = files.registry.resolve(files.workspace, {
        ARG_SECRET: 'argument-template-secret',
        ROUTE_SECRET: 'private-route'
    });

    assert.deepEqual(new Set(result.redactionValues), new Set([
        'argument-template-secret',
        'literal-env-secret',
        'private-route',
        'literal-header-secret'
    ]));
    for (const ordinary of ['node', '--credential', 'ordinary-argument', 'https://mcp.example.test/private-route']) {
        assert.equal(result.redactionValues.includes(ordinary), false, `${ordinary} is not itself a secret`);
    }
});

test('fingerprints are canonical, ignore TOML ordering, and include resolved credentials', t => {
    const files = fixture(t);
    const firstSource = [
        '[mcp_servers.zeta]',
        'command = "node"',
        'args = ["server.js"]',
        'env = { ZETA = "z", TOKEN = "${TOKEN}" }',
        '',
        '[mcp_servers.alpha]',
        'url = "https://mcp.example.test/mcp"',
        'headers = { Zed = "z", Alpha = "a" }'
    ].join('\n');
    files.user(firstSource);
    const first = files.registry.resolve(files.workspace, { TOKEN: 'one' });
    assert.equal(fs.readFileSync(path.join(files.grokHome, 'config.toml'), 'utf8'), `${firstSource}\n`, 'resolution is memory-only');

    files.user([
        '[mcp_servers.alpha]',
        'headers = { Alpha = "a", Zed = "z" }',
        'url = "https://mcp.example.test/mcp"',
        '',
        '[mcp_servers.zeta]',
        'env = { TOKEN = "${TOKEN}", ZETA = "z" }',
        'args = ["server.js"]',
        'command = "node"'
    ].join('\n'));
    const reordered = files.registry.resolve(files.workspace, { TOKEN: 'one' });
    const rotatedSecret = files.registry.resolve(files.workspace, { TOKEN: 'two' });

    assert.deepEqual(reordered.mcpServers, first.mcpServers);
    assert.equal(reordered.fingerprint, first.fingerprint);
    assert.notEqual(rotatedSecret.fingerprint, first.fingerprint);
});

test('a project override is a complete replacement rather than a field merge', t => {
    const files = fixture(t);
    files.user([
        '[mcp_servers.shared]',
        'command = "node"',
        'args = ["server.js"]'
    ].join('\n'));
    files.project([
        '[mcp_servers.shared]',
        'enabled = true'
    ].join('\n'));

    assert.throws(
        () => files.registry.resolve(files.workspace, {}),
        /must define exactly one of command or url/
    );
});

test('missing environment values and malformed templates fail closed without leaking values', t => {
    const files = fixture(t);
    files.user([
        '[mcp_servers.secure]',
        'url = "https://mcp.example.test/mcp"',
        'headers = { Authorization = "Bearer ${MISSING_TOKEN}" }'
    ].join('\n'));
    assert.throws(
        () => files.registry.resolve(files.workspace, {}),
        /requires environment variable MISSING_TOKEN/
    );

    files.user([
        '[mcp_servers.secure]',
        'command = "${lowercase_is_rejected}"'
    ].join('\n'));
    assert.throws(
        () => files.registry.resolve(files.workspace, { lowercase_is_rejected: 'do-not-leak' }),
        error => {
            assert.doesNotMatch(error.message, /do-not-leak/);
            assert.match(error.message, /invalid environment template/);
            return true;
        }
    );
});

test('invalid names, endpoints, headers, commands, and bearer conflicts are rejected safely', async t => {
    const files = fixture(t);
    const cases = [{
        name: 'unsafe server name',
        source: '[mcp_servers."bad.name"]\ncommand = "node"',
        environment: {},
        pattern: /unsafe server name/
    }, {
        name: 'both endpoints',
        source: '[mcp_servers.both]\ncommand = "node"\nurl = "https://example.test/mcp"',
        environment: {},
        pattern: /exactly one/
    }, {
        name: 'conflicting transport aliases',
        source: '[mcp_servers.remote]\nurl = "https://example.test/mcp"\ntype = "http"\ntransport_type = "sse"',
        environment: {},
        pattern: /conflicting transport fields/
    }, {
        name: 'URL credentials',
        source: '[mcp_servers.remote]\nurl = "https://user:top-secret@example.test/mcp"',
        environment: {},
        pattern: /unsafe URL/,
        absent: /top-secret/
    }, {
        name: 'unsupported protocol',
        source: '[mcp_servers.remote]\nurl = "file:///tmp/socket"',
        environment: {},
        pattern: /unsafe URL/
    }, {
        name: 'header injection after expansion',
        source: '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nheaders = { Test = "${HEADER}" }',
        environment: { HEADER: 'safe\r\ninjected: yes' },
        pattern: /unsafe HTTP header/
    }, {
        name: 'command injection after expansion',
        source: '[mcp_servers.local]\ncommand = "${COMMAND}"',
        environment: { COMMAND: 'node\nmalicious' },
        pattern: /unsafe command/
    }, {
        name: 'duplicate authorization sources',
        source: '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nheaders = { Authorization = "Bearer explicit" }\nbearer_token_env_var = "TOKEN"',
        environment: { TOKEN: 'top-secret' },
        pattern: /defines Authorization twice/,
        absent: /top-secret/
    }];

    for (const entry of cases) {
        await t.test(entry.name, () => {
            files.user(entry.source);
            assert.throws(
                () => files.registry.resolve(files.workspace, entry.environment),
                error => {
                    assert.match(error.message, entry.pattern);
                    if (entry.absent) assert.doesNotMatch(error.message, entry.absent);
                    return true;
                }
            );
        });
    }
});

test('registry validates roots and bounds config input before parsing', t => {
    const files = fixture(t);
    assert.throws(() => files.registry.resolve('relative/workspace', {}), /absolute path/);

    const bounded = new RuntimeMcpRegistry({ grokHome: files.grokHome, maxConfigBytes: 16 });
    files.user('[mcp_servers.one]\ncommand = "node"');
    assert.throws(() => bounded.resolve(files.workspace, {}), /too large/);
});

test('resolved redaction values are bounded and overflow errors do not reveal a value', t => {
    const files = fixture(t);
    const lines = [];
    const environment = {};
    const secret = 's'.repeat(64 * 1024);
    for (let index = 0; index < 33; index += 1) {
        lines.push(
            `[mcp_servers.server${index}]`,
            'command = "node"',
            `env = { TOKEN = "\${SECRET_${index}}" }`,
            ''
        );
        environment[`SECRET_${index}`] = `${secret.slice(0, -4)}${String(index).padStart(4, '0')}`;
    }
    files.user(lines.join('\n'));

    assert.throws(
        () => files.registry.resolve(files.workspace, environment),
        error => {
            assert.match(error.message, /redaction set is too large/);
            assert.doesNotMatch(error.message, /ssssssssssssssss/);
            return true;
        }
    );
});

function createSymlinkOrSkip(t, target, link, type) {
    try {
        fs.symlinkSync(target, link, type);
        return true;
    } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
            t.skip(`symbolic links are unavailable on this runner: ${error.code}`);
            return false;
        }
        throw error;
    }
}

test('user and project MCP sources reject symbolic-link traversal', async t => {
    await t.test('user config.toml symbolic link', t => {
        const files = fixture(t);
        const external = path.join(path.dirname(files.grokHome), 'external-user.toml');
        fs.writeFileSync(external, '[mcp_servers.external]\ncommand = "node"\n');
        if (!createSymlinkOrSkip(t, external, path.join(files.grokHome, 'config.toml'), 'file')) return;
        assert.throws(
            () => files.registry.resolve(files.workspace, {}),
            /user MCP configuration must be a regular file, not a symbolic link/
        );
    });

    await t.test('project config.toml symbolic link', t => {
        const files = fixture(t);
        const external = path.join(path.dirname(files.workspace), 'external-project.toml');
        fs.writeFileSync(external, '[mcp_servers.external]\ncommand = "node"\n');
        if (!createSymlinkOrSkip(t, external, path.join(files.workspace, '.grok', 'config.toml'), 'file')) return;
        assert.throws(
            () => files.registry.resolve(files.workspace, {}),
            /project MCP configuration must be a regular file, not a symbolic link/
        );
    });

    await t.test('project .grok directory symbolic link', t => {
        const files = fixture(t);
        const external = path.join(path.dirname(files.workspace), 'external-grok');
        fs.mkdirSync(external);
        fs.writeFileSync(path.join(external, 'config.toml'), '[mcp_servers.external]\ncommand = "node"\n');
        fs.rmdirSync(path.join(files.workspace, '.grok'));
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        if (!createSymlinkOrSkip(t, external, path.join(files.workspace, '.grok'), type)) return;
        assert.throws(
            () => files.registry.resolve(files.workspace, {}),
            /project \.grok path must be a regular directory, not a symbolic link/
        );
    });
});

test('remote MCP transport permits plaintext only for strict loopback without credentials', async t => {
    const files = fixture(t);
    const invalid = [{
        name: 'non-loopback plaintext endpoint',
        source: '[mcp_servers.remote]\nurl = "http://example.test/mcp"',
        environment: {},
        pattern: /must use HTTPS/
    }, {
        name: 'lookalike loopback hostname',
        source: '[mcp_servers.remote]\nurl = "http://localhost.example.test/mcp"',
        environment: {},
        pattern: /must use HTTPS/
    }, {
        name: 'plaintext sensitive header',
        source: '[mcp_servers.remote]\nurl = "http://127.0.0.1:8787/mcp"\nheaders = { "Proxy-Authorization" = "plaintext-header-secret" }',
        environment: {},
        pattern: /sensitive HTTP header over plaintext HTTP/,
        absent: /plaintext-header-secret/
    }, {
        name: 'plaintext bearer token',
        source: '[mcp_servers.remote]\nurl = "http://localhost:8787/mcp"\nbearer_token_env_var = "MCP_TOKEN"',
        environment: { MCP_TOKEN: 'plaintext-bearer-secret' },
        pattern: /bearer token over plaintext HTTP/,
        absent: /plaintext-bearer-secret/
    }, {
        name: 'credential-like URL query',
        source: '[mcp_servers.remote]\nurl = "https://example.test/mcp?x-api-key=query-secret"',
        environment: {},
        pattern: /credentials in URL query parameters/,
        absent: /query-secret/
    }];

    for (const entry of invalid) {
        await t.test(entry.name, () => {
            files.user(entry.source);
            assert.throws(() => files.registry.resolve(files.workspace, entry.environment), error => {
                assert.match(error.message, entry.pattern);
                if (entry.absent) assert.doesNotMatch(error.message, entry.absent);
                return true;
            });
        });
    }

    files.user([
        '[mcp_servers.ipv4]',
        'url = "http://127.0.0.1:8787/mcp?version=1"',
        'headers = { "X-Client-Version" = "0.2.1" }',
        '',
        '[mcp_servers.ipv6]',
        'type = "sse"',
        'url = "http://[::1]:8788/sse"'
    ].join('\n'));
    const allowed = files.registry.resolve(files.workspace, {});
    assert.deepEqual(allowed.enabledNames, ['ipv4', 'ipv6']);
});

test('stdio command and arguments reject literal credentials but allow environment templates', async t => {
    const files = fixture(t);
    const secret = 'literal-secret-that-must-not-leak';
    const invalid = [{
        name: 'credential flag pair in command',
        source: `[mcp_servers.local]\ncommand = "node --api-key ${secret}"`
    }, {
        name: 'credential flag pair in args',
        source: `[mcp_servers.local]\ncommand = "node"\nargs = ["--token", "${secret}"]`
    }, {
        name: 'credential flag assignment',
        source: `[mcp_servers.local]\ncommand = "node"\nargs = ["--client-secret=${secret}"]`
    }, {
        name: 'credential environment assignment in args',
        source: `[mcp_servers.local]\ncommand = "node"\nargs = ["MCP_API_KEY=${secret}"]`
    }, {
        name: 'bearer literal in args',
        source: `[mcp_servers.local]\ncommand = "node"\nargs = ["Bearer ${secret}"]`
    }, {
        name: 'credential URL query in args',
        source: `[mcp_servers.local]\ncommand = "node"\nargs = ["https://example.test/mcp?access_token=${secret}"]`
    }, {
        name: 'well-known API token prefix in args',
        source: '[mcp_servers.local]\ncommand = "node"\nargs = ["sk-1234567890abcdef"]'
    }];

    for (const entry of invalid) {
        await t.test(entry.name, () => {
            files.user(entry.source);
            assert.throws(() => files.registry.resolve(files.workspace, {}), error => {
                assert.match(error.message, /must reference credentials through an environment template/);
                assert.doesNotMatch(error.message, new RegExp(secret));
                return true;
            });
        });
    }

    files.user([
        '[mcp_servers.local]',
        'command = "${NODE_BIN}"',
        'args = ["--api-key", "${MCP_TOKEN}", "--endpoint", "https://example.test/mcp?version=1"]',
        'env = { MCP_TOKEN = "${MCP_TOKEN}" }'
    ].join('\n'));
    const allowed = files.registry.resolve(files.workspace, {
        NODE_BIN: '/opt/bin/node',
        MCP_TOKEN: 'template-only-secret'
    });
    assert.deepEqual(allowed.mcpServers, [{
        name: 'local',
        command: '/opt/bin/node',
        args: ['--api-key', 'template-only-secret', '--endpoint', 'https://example.test/mcp?version=1'],
        env: [{ name: 'MCP_TOKEN', value: 'template-only-secret' }]
    }]);
});
