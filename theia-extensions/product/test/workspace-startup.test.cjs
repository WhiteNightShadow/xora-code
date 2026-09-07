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

    const server = new XoraWorkspaceServer();
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(folder).toString()), true);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(workspace).toString()), true);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(script).toString()), false);
    assert.equal(await server.isValidWorkspaceRoot(FileUri.create(path.join(root, 'missing')).toString()), false);
});

test('an invalid remembered script is removed before choosing the next project', async () => {
    const server = new XoraWorkspaceServer();
    const valid = 'file:///workspace/project';
    let written;
    server.getWorkspaceURIFromCli = async () => undefined;
    server.readRecentWorkspacePathsFromUserHome = async () => ({
        recentRoots: ['file:///tmp/xora-qa-main.cjs', valid]
    });
    server.workspaceRootStatus = async uri => uri === valid ? 'valid' : 'invalid';
    server.writeToUserHome = async data => { written = data; };

    assert.equal(await server.getRoot(), valid);
    assert.deepEqual(written, { recentRoots: [valid] });
});

test('offline history is preserved and startup never probes older network drives', async () => {
    const server = new XoraWorkspaceServer();
    const offline = 'file:///Volumes/offline/project';
    const history = [offline, 'file:///Volumes/another/project', 'file:///workspace/healthy'];
    const inspected = [];
    server.getWorkspaceURIFromCli = async () => undefined;
    server.readRecentWorkspacePathsFromUserHome = async () => ({ recentRoots: history });
    server.workspaceRootStatus = async uri => { inspected.push(uri); return 'unavailable'; };
    server.writeToUserHome = async () => assert.fail('unavailable history must not be pruned');
    assert.equal(await server.getRoot(), offline);
    assert.deepEqual(inspected, [offline]);
    assert.deepEqual(await server.getRecentWorkspaces(), history);
    assert.deepEqual(inspected, [offline], 'recent list must not stat offline drives');
});

test('recovering to an empty window retains all recent workspaces', async () => {
    const server = new XoraWorkspaceServer();
    const history = ['file:///Volumes/offline/project', 'file:///workspace/healthy'];
    let written;
    server.readRecentWorkspacePathsFromUserHome = async () => ({ recentRoots: history });
    server.writeToUserHome = async data => { written = data; };
    await server.setMostRecentlyUsedWorkspace('');
    assert.deepEqual(written.recentRoots, ['', ...history]);
    assert.equal(await server.getMostRecentlyUsedWorkspace(), '');
    server.getWorkspaceURIFromCli = async () => undefined;
    server.readRecentWorkspacePathsFromUserHome = async () => written;
    server.workspaceRootStatus = async () => assert.fail('an explicit empty window must not probe old roots');
    assert.equal(await server.getRoot(), undefined);
});

test('unreadable history does not get replaced by an incomplete recent list', async () => {
    const server = new XoraWorkspaceServer();
    server.readRecentWorkspacePathsFromUserHome = async () => { throw new Error('network home unavailable'); };
    server.writeToUserHome = async () => assert.fail('preserve the unreadable history file');
    await server.setMostRecentlyUsedWorkspace('');
    assert.equal(await server.getMostRecentlyUsedWorkspace(), '');
    assert.deepEqual(await server.getRecentWorkspaces(), []);
});

test('a late initial root cannot replace a newer empty-window selection', async () => {
    const server = new XoraWorkspaceServer();
    let resolveRoot;
    server.workspaceIoTimeout = 5;
    server.getRoot = () => new Promise(resolve => { resolveRoot = resolve; });
    server.readRecentWorkspacePathsFromUserHome = async () => ({ recentRoots: [] });
    server.writeToUserHome = async () => undefined;
    const initialization = server.doInit();
    await server.setMostRecentlyUsedWorkspace('');
    await initialization;
    resolveRoot('file:///Volumes/offline/project');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await server.getMostRecentlyUsedWorkspace(), '');
});

test('older history reads cannot overwrite a newer manual selection', async () => {
    const server = new XoraWorkspaceServer();
    let resolveOldRead;
    let first = true;
    const writes = [];
    server.readRecentWorkspacePathsFromUserHome = async () => {
        if (first) {
            first = false;
            return new Promise(resolve => { resolveOldRead = resolve; });
        }
        return { recentRoots: ['file:///workspace/healthy'] };
    };
    server.writeToUserHome = async data => { writes.push(data); };
    const old = server.setMostRecentlyUsedWorkspace('file:///workspace/old');
    await server.setMostRecentlyUsedWorkspace('');
    resolveOldRead({ recentRoots: ['file:///workspace/healthy'] });
    await old;
    assert.deepEqual(writes, [{ recentRoots: ['', 'file:///workspace/healthy'] }]);
});

test('an initial lookup timeout cannot cancel persistence of a newer selection', async () => {
    const server = new XoraWorkspaceServer();
    let completeRead;
    let written;
    server.workspaceIoTimeout = 5;
    server.getRoot = () => new Promise(() => {});
    server.readRecentWorkspacePathsFromUserHome = () => new Promise(resolve => { completeRead = resolve; });
    server.writeToUserHome = async data => { written = data; };
    const initialization = server.doInit();
    const selection = server.setMostRecentlyUsedWorkspace('');
    await initialization;
    completeRead({ recentRoots: ['file:///workspace/healthy'] });
    await selection;
    assert.deepEqual(written, { recentRoots: ['', 'file:///workspace/healthy'] });
});

test('startup does not run untitled-workspace deletion on offline volumes', async () => {
    const server = new XoraWorkspaceServer();
    server.removeOldUntitledWorkspaces = () => assert.fail('startup must not delete disconnected workspace documents');
    await server.onStart();
});
