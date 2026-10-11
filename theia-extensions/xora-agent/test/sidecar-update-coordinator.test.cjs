const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
    if (request === './sidecar-supervisor') return { GrokSidecarSupervisor: class {} };
    return originalLoad.call(this, request, parent, isMain);
};
let SidecarUpdateCoordinator;
try {
    ({ SidecarUpdateCoordinator } = require('../lib/electron-main/sidecar-update-coordinator'));
} finally {
    Module._load = originalLoad;
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-embedded-bootstrap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    fs.writeFileSync(source, 'fixture embedded executable');
    const contract = path.join(root, 'contract');
    fs.writeFileSync(contract, '{}');
    const coordinator = new SidecarUpdateCoordinator();
    coordinator.componentRoot = path.join(root, 'components');
    coordinator.embeddedBinaryPath = () => source;
    coordinator.updateContractPath = () => contract;
    return { coordinator, source, directory: path.join(coordinator.componentRoot, 'embedded') };
}

const config = { channel: 'stable', homeCompatEpoch: 1 };

test('first update durably bootstraps the embedded rollback binary on the native filesystem', async t => {
    const { coordinator, source, directory } = fixture(t);
    const release = await coordinator.bootstrapEmbedded(config);
    const binary = path.join(directory, process.platform === 'win32' ? 'grok.exe' : 'grok');
    assert.deepEqual(fs.readFileSync(binary), fs.readFileSync(source));
    assert.equal(release.artifactSha256, crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
    assert.equal(release.artifactSize, fs.statSync(source).size);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(binary)]);
    assert.deepEqual(await coordinator.bootstrapEmbedded(config), release);
});

test('failed embedded flush leaves no published baseline or temporary file and can retry', async t => {
    const { coordinator, directory } = fixture(t);
    const failure = Object.assign(new Error('fixture flush failure'), { code: 'EPERM' });
    const mock = t.mock.method(fs, 'fsyncSync', () => { throw failure; });
    await assert.rejects(coordinator.bootstrapEmbedded(config), error => error === failure);
    assert.deepEqual(fs.readdirSync(directory), []);
    mock.mock.restore();
    assert.equal((await coordinator.bootstrapEmbedded(config)).version, '0.2.102');
    assert.equal(fs.readdirSync(directory).length, 1);
});
