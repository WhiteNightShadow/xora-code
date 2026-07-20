const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    GROK_SIDECAR_INACCESSIBLE_MESSAGE,
    GROK_SIDECAR_MISSING_MESSAGE,
    sidecarFilesystemError
} = require('../lib/electron-main/sidecar-errors');

test('missing sidecar errors are Chinese, actionable, and do not leak the package path', () => {
    const failure = Object.assign(new Error("ENOENT: no such file or directory, lstat '/Users/example/Xora Code/grok'"), {
        code: 'ENOENT',
        path: '/Users/example/Xora Code/grok'
    });
    const translated = sidecarFilesystemError(failure);

    assert.equal(translated.message, GROK_SIDECAR_MISSING_MESSAGE);
    assert.match(translated.message, /Grok Build 0\.2\.102/);
    assert.match(translated.message, /完整构建/);
    assert.doesNotMatch(translated.message, /Users|ENOENT|lstat/);
});

test('sidecar permission failures suggest checking the installation', () => {
    const translated = sidecarFilesystemError(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    assert.equal(translated.message, GROK_SIDECAR_INACCESSIBLE_MESSAGE);
    assert.match(translated.message, /权限|重新安装/);
});

test('Grok subscription management uses the pinned CLI login/logout contract', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    assert.match(source, /runCli\(\['login', '--oauth'\], false/);
    assert.match(source, /runCli\(\['logout'\], false/);
});
