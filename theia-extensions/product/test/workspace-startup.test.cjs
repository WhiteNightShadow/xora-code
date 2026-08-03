const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FileUri } = require('@theia/core/lib/node');

const { XoraWorkspaceServer } = require('../lib/node/xora-workspace-server');

test('the product Explorer omits Theia Timeline without removing provider support', () => {
    const sourceRoot = path.join(__dirname, '..', 'src', 'browser');
    const moduleSource = fs.readFileSync(path.join(sourceRoot, 'xora-product-frontend-module.ts'), 'utf8');
    const contributionSource = fs.readFileSync(path.join(sourceRoot, 'xora-timeline-contribution.ts'), 'utf8');
    const explorerSource = fs.readFileSync(path.join(sourceRoot, 'xora-explorer-contribution.ts'), 'utf8');
    const manifest = require('../package.json');

    assert.equal(manifest.dependencies['@theia/timeline'], '1.73.1');
    assert.match(moduleSource, /rebind\(TimelineContribution\)\.to\(XoraTimelineContribution\)/);
    assert.match(contributionSource, /Deliberately omit Theia's Explorer attachment listener/);
    assert.doesNotMatch(contributionSource, /explorer\.addWidget|TimelineWidget\.ID/);
    assert.match(explorerSource, /tryGetWidget<TimelineWidget>\(TimelineWidget\.ID\)\?\.close\(\)/,
        'saved layouts from older releases must also shed an already-restored Timeline pane');
});

test('empty-window restore ignores scripts and keeps real workspaces', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-workspace-startup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const folder = path.join(root, 'project');
    const script = path.join(root, 'theia-electron-main.js');
    const workspace = path.join(root, 'project.code-workspace');
    fs.mkdirSync(folder);
    fs.writeFileSync(script, 'require("electron");\n');
    fs.writeFileSync(workspace, '{"folders":[]}\n');

    const server = Object.create(XoraWorkspaceServer.prototype);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(folder).toString()), true);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(workspace).toString()), true);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(script).toString()), false);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(path.join(root, 'missing')).toString()), false);
});

test('an invalid remembered script is removed before choosing the next project', async () => {
    const server = Object.create(XoraWorkspaceServer.prototype);
    const valid = 'file:///workspace/project';
    let written;
    server.getWorkspaceURIFromCli = async () => undefined;
    server.readRecentWorkspacePathsFromUserHome = async () => ({
        recentRoots: ['file:///tmp/xora-qa-main.cjs', valid]
    });
    server.isValidWorkspaceRoot = async uri => uri === valid;
    server.writeToUserHome = async data => { written = data; };

    assert.equal(await server.getRoot(), valid);
    assert.deepEqual(written, { recentRoots: [valid] });
});
