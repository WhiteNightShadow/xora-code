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
