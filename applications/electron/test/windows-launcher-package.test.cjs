'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertWindowsJobGuardian } = require('../scripts/sanitize-after-pack');

test('Windows packaging requires the exact guardian as a physical unpacked file', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-windows-launcher-package-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const context = { appOutDir: root, electronPlatformName: 'win32' };
    assert.throws(() => assertWindowsJobGuardian(context), /Windows Agent launcher/);
    const target = path.join(root, 'resources', 'app.asar.unpacked', 'scripts', 'windows-process-job.ps1');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../scripts/windows-process-job.ps1'), target);
    assert.doesNotThrow(() => assertWindowsJobGuardian(context));
    fs.appendFileSync(target, '\n# unexpected modification\n');
    assert.throws(() => assertWindowsJobGuardian(context), /Windows Agent launcher/);
});

test('other platforms do not require a Windows launcher payload', () => {
    for (const electronPlatformName of ['darwin', 'linux']) {
        assert.doesNotThrow(() => assertWindowsJobGuardian({ electronPlatformName }));
    }
});
