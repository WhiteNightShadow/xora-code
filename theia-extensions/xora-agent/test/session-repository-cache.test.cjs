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
