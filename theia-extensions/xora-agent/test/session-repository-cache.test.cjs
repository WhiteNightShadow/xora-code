const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentSessionRepository } = require('../lib/electron-main/session-repository');

test('session index snapshots reuse the parsed cache and observe atomic external replacement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-cache-'));
    const indexPath = path.join(root, 'index.json');
    const initial = {
        schemaVersion: 1,
        sessions: [{
            appSessionId: '00000000-0000-4000-8000-000000000001',
            acpSessionId: 'acp-a',
            title: 'A',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
            status: 'idle'
        }]
    };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify(initial)}\n`);

    const repository = new AgentSessionRepository(root);
    const originalReadFileSync = fs.readFileSync;
    let indexReads = 0;
    fs.readFileSync = function (...args) {
        if (path.resolve(String(args[0])) === path.resolve(indexPath)) indexReads += 1;
        return originalReadFileSync.apply(this, args);
    };
    try {
        assert.equal(repository.list()[0].title, 'A');
        assert.equal(repository.list()[0].title, 'A');
        assert.equal(indexReads, 1, 'unchanged snapshots must not repeatedly parse index.json');

        const replacement = `${indexPath}.replacement`;
        const external = {
            ...initial,
            sessions: [{ ...initial.sessions[0], title: 'B', updatedAt: '2026-07-20T00:01:00.000Z' }]
        };
        fs.writeFileSync(replacement, `${JSON.stringify(external)}\n`);
        fs.renameSync(replacement, indexPath);

        assert.equal(repository.list()[0].title, 'B');
        assert.equal(indexReads, 2, 'atomic replacement from another window invalidates the cache');
    } finally {
        fs.readFileSync = originalReadFileSync;
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('mutating a returned session snapshot cannot corrupt the repository cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-clone-'));
    try {
        const repository = new AgentSessionRepository(root);
        const created = repository.create({
            acpSessionId: 'acp-a',
            title: 'Original',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const visible = repository.list();
        visible[0].title = 'Renderer mutation';

        assert.equal(repository.get(created.appSessionId)?.title, 'Original');
        repository.dispose();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('history reads reuse parsed JSONL and only parse bytes appended by another window', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-event-cache-'));
    const appSessionId = '00000000-0000-4000-8000-000000000011';
    const historyPath = path.join(root, `${appSessionId}.jsonl`);
    const envelope = text => `${JSON.stringify({
        schemaVersion: 1,
        timestamp: '2026-07-23T00:00:00.000Z',
        event: { kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text }
    })}\n`;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(historyPath, envelope('first'));

    const repository = new AgentSessionRepository(root);
    const originalReadSync = fs.readSync;
    const requestedLengths = [];
    fs.readSync = function (...args) {
        requestedLengths.push(args[3]);
        return originalReadSync.apply(this, args);
    };
    try {
        assert.deepEqual(repository.readEvents(appSessionId).map(event => event.text), ['first']);
        const readsAfterFirstParse = requestedLengths.length;
        assert.deepEqual(repository.readEvents(appSessionId).map(event => event.text), ['first']);
        assert.equal(requestedLengths.length, readsAfterFirstParse, 'unchanged JSONL must not be read or parsed twice');

        const appended = envelope('from another window');
        fs.appendFileSync(historyPath, appended);
        assert.deepEqual(repository.readEvents(appSessionId).map(event => event.text), ['first', 'from another window']);
        assert.equal(requestedLengths.at(-1), Buffer.byteLength(appended), 'only the externally appended suffix is read');
    } finally {
        fs.readSync = originalReadSync;
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('history reads include pending events without forcing fsync and shutdown remains durable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-pending-history-'));
    const appSessionId = '00000000-0000-4000-8000-000000000012';
    const repository = new AgentSessionRepository(root);
    const originalFsyncSync = fs.fsyncSync;
    let fsyncs = 0;
    fs.fsyncSync = function (...args) {
        fsyncs += 1;
        return originalFsyncSync.apply(this, args);
    };
    try {
        repository.appendEvent(appSessionId, {
            kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text: 'not flushed yet'
        });
        assert.deepEqual(repository.readEvents(appSessionId).map(event => event.text), ['not flushed yet']);
        assert.equal(fsyncs, 0, 'switching history must not turn a pending stream batch into a synchronous fsync');
    } finally {
        fs.fsyncSync = originalFsyncSync;
        repository.dispose();
    }

    try {
        const rebuilt = new AgentSessionRepository(root);
        assert.deepEqual(rebuilt.readEvents(appSessionId).map(event => event.text), ['not flushed yet']);
        rebuilt.dispose();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Diff history repairs redacted v0.2.0 before-image paths and keeps new snapshot paths redactable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-diff-history-'));
    const appSessionId = '00000000-0000-4000-8000-000000000013';
    const repository = new AgentSessionRepository(root);
    try {
        const oldText = 'const version = "before";\n';
        const oldHash = require('node:crypto').createHash('sha256').update(oldText).digest('hex');
        const afterText = 'externally repaired after image\n';
        const newHash = require('node:crypto').createHash('sha256').update(afterText).digest('hex');
        const legacyDirectory = path.join(root, 'diffs', appSessionId);
        const legacyPath = path.join(legacyDirectory, `${oldHash}.ts`);
        fs.mkdirSync(legacyDirectory, { recursive: true });
        fs.writeFileSync(legacyPath, oldText);

        repository.appendEvent(appSessionId, {
            kind: 'diff',
            diffId: '00000000-0000-4000-8000-000000000099',
            sessionId: appSessionId,
            path: 'src/version.ts',
            oldPath: path.join(legacyDirectory, '[REDACTED_BINARY_PAYLOAD].ts'),
            oldHash,
            newHash,
            diff: '-before\n+after'
        });

        const restored = repository.readEvents(appSessionId)[0];
        assert.equal(restored.oldPath, legacyPath, 'legacy bare-hash snapshots remain reviewable');
        assert.equal(restored.newPath, undefined, 'a missing after snapshot must not leave a broken URI');

        const externallyRepaired = path.join(legacyDirectory, `before-${newHash}.ts`);
        fs.writeFileSync(externallyRepaired, afterText);
        const changed = new Date(Date.now() + 5000);
        fs.utimesSync(legacyDirectory, changed, changed);
        assert.equal(repository.readEvents(appSessionId)[0].newPath, externallyRepaired,
            'a cross-window directory change invalidates a cached missing snapshot');

        const current = repository.saveBeforeImage(appSessionId, 'src/version.ts', 'const version = "after";\n');
        const { deepRedact } = require('../lib/electron-main/session-repository');
        assert.match(path.basename(current.path), /^before-[0-9a-f]{64}\.ts$/);
        assert.equal(deepRedact(current.path), current.path, 'new content-addressed paths survive renderer redaction');
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Diff history refuses a content-addressed snapshot whose bytes no longer match its hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-diff-integrity-'));
    const appSessionId = '00000000-0000-4000-8000-000000000015';
    const repository = new AgentSessionRepository(root);
    try {
        const snapshot = repository.saveBeforeImage(appSessionId, 'src/integrity.ts', 'trusted\n');
        repository.appendEvent(appSessionId, {
            kind: 'diff',
            diffId: '00000000-0000-4000-8000-000000000098',
            sessionId: appSessionId,
            path: 'src/integrity.ts',
            oldHash: snapshot.hash,
            newHash: 'f'.repeat(64),
            diff: '-trusted\n+changed'
        });
        fs.writeFileSync(snapshot.path, 'tampered\n');

        const restored = repository.readEvents(appSessionId)[0];
        assert.equal(restored.oldPath, undefined);
        assert.equal(restored.newPath, undefined);
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('cached Diff history does not lstat every snapshot again while its directory is unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-diff-path-cache-'));
    const appSessionId = '00000000-0000-4000-8000-000000000014';
    const repository = new AgentSessionRepository(root);
    const historyPath = path.join(root, `${appSessionId}.jsonl`);
    const diffDirectory = path.join(root, 'diffs', appSessionId);
    const events = [];
    try {
        for (let index = 0; index < 48; index += 1) {
            const relativePath = `src/file-${index}.ts`;
            const before = repository.saveBeforeImage(appSessionId, relativePath, `before ${index}\n`);
            const after = repository.saveBeforeImage(appSessionId, relativePath, `after ${index}\n`);
            events.push({
                kind: 'diff',
                diffId: `diff-${index}`,
                sessionId: appSessionId,
                path: relativePath,
                oldHash: before.hash,
                newHash: after.hash,
                diff: `-before ${index}\n+after ${index}`
            });
        }
        fs.writeFileSync(historyPath, events.map(event => `${JSON.stringify({
            schemaVersion: 1,
            timestamp: '2026-07-23T00:00:00.000Z',
            event
        })}\n`).join(''));

        const originalLstatSync = fs.lstatSync;
        let snapshotStats = 0;
        let directoryStats = 0;
        fs.lstatSync = function (...args) {
            const target = path.resolve(String(args[0]));
            if (target === path.resolve(diffDirectory)) directoryStats += 1;
            else if (path.dirname(target) === path.resolve(diffDirectory)) snapshotStats += 1;
            return originalLstatSync.apply(this, args);
        };
        try {
            const first = repository.readEvents(appSessionId);
            assert.equal(first.length, events.length);
            assert.ok(first.every(event => event.oldPath && event.newPath));
            assert.equal(snapshotStats, events.length * 2, 'the cold read validates each distinct immutable snapshot once');

            const coldSnapshotStats = snapshotStats;
            const second = repository.readEvents(appSessionId);
            assert.equal(second.length, events.length);
            assert.equal(snapshotStats, coldSnapshotStats,
                'a cached JSONL read must not synchronously lstat old/new paths for every Diff card');
            assert.equal(directoryStats, 2,
                'cross-window invalidation costs one directory identity check per history read');
        } finally {
            fs.lstatSync = originalLstatSync;
        }
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
