const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentSessionRepository } = require('../lib/electron-main/session-repository');

const sessions = [
    {
        appSessionId: '00000000-0000-4000-8000-000000000001',
        acpSessionId: 'acp-relay-first',
        title: 'Relay first',
        workspaceRoot: '/fixture/first',
        providerId: 'xora-relay',
        model: 'xora-relay',
        createdAt: '2026-07-18T08:00:00.000Z',
        updatedAt: '2026-07-18T08:30:00.000Z',
        status: 'completed'
    },
    {
        appSessionId: '00000000-0000-4000-8000-000000000002',
        acpSessionId: 'acp-subscription',
        title: 'Subscription',
        workspaceRoot: '/fixture/subscription',
        providerId: 'grok-subscription',
        model: 'grok-4.5',
        createdAt: '2026-07-19T08:00:00.000Z',
        updatedAt: '2026-07-19T08:30:00.000Z',
        status: 'idle'
    },
    {
        appSessionId: '00000000-0000-4000-8000-000000000003',
        acpSessionId: 'acp-relay-second',
        title: 'Relay second',
        workspaceRoot: '/fixture/second',
        providerId: 'xora-relay',
        model: 'xora-relay',
        createdAt: '2026-07-20T08:00:00.000Z',
        updatedAt: '2026-07-20T08:30:00.000Z',
        status: 'failed'
    }
];

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-retirement-'));
    const indexPath = path.join(root, 'index.json');
    fs.writeFileSync(indexPath, `${JSON.stringify({ schemaVersion: 1, sessions }, undefined, 2)}\n`);
    return { root, indexPath };
}

function readIndex(indexPath) {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

test('retiring a Provider only marks its sessions read-only without changing timestamps or history order', () => {
    const { root, indexPath } = createFixture();
    const repository = new AgentSessionRepository(root);
    try {
        const retired = repository.markProviderSessionsReadOnly('xora-relay');
        const persisted = readIndex(indexPath).sessions;

        assert.deepEqual(retired.map(session => [session.appSessionId, session.status]), [
            [sessions[0].appSessionId, 'read-only'],
            [sessions[2].appSessionId, 'read-only']
        ]);
        assert.deepEqual(persisted.map(session => session.appSessionId), sessions.map(session => session.appSessionId));
        assert.deepEqual(persisted[1], sessions[1], 'another Provider must remain byte-for-byte equivalent');
        for (let position = 0; position < sessions.length; position += 1) {
            assert.equal(persisted[position].createdAt, sessions[position].createdAt);
            assert.equal(persisted[position].updatedAt, sessions[position].updatedAt);
        }
        assert.equal(persisted[0].status, 'read-only');
        assert.equal(persisted[2].status, 'read-only');
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('retiring a Provider is idempotent and does not replace an unchanged index', () => {
    const { root, indexPath } = createFixture();
    const repository = new AgentSessionRepository(root);
    try {
        repository.markProviderSessionsReadOnly('xora-relay');
        const firstContents = fs.readFileSync(indexPath, 'utf8');
        const firstInode = fs.statSync(indexPath).ino;

        const retiredAgain = repository.markProviderSessionsReadOnly('xora-relay');

        assert.ok(retiredAgain.every(session => session.status === 'read-only'));
        assert.equal(fs.readFileSync(indexPath, 'utf8'), firstContents);
        assert.equal(fs.statSync(indexPath).ino, firstInode, 'idempotent retirement must not atomically replace index.json');
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('retired Provider sessions remain read-only after rebuilding the repository', () => {
    const { root } = createFixture();
    const firstRepository = new AgentSessionRepository(root);
    try {
        firstRepository.markProviderSessionsReadOnly('xora-relay');
        firstRepository.dispose();

        const rebuiltRepository = new AgentSessionRepository(root);
        try {
            assert.equal(rebuiltRepository.get(sessions[0].appSessionId)?.status, 'read-only');
            assert.equal(rebuiltRepository.get(sessions[2].appSessionId)?.status, 'read-only');
            assert.equal(rebuiltRepository.get(sessions[1].appSessionId)?.status, sessions[1].status);
        } finally {
            rebuiltRepository.dispose();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Provider session retirement honors the cross-process index lock', () => {
    const { root, indexPath } = createFixture();
    const lockPath = path.join(root, '.index.lock');
    const repository = new AgentSessionRepository(root);
    const before = fs.readFileSync(indexPath, 'utf8');
    try {
        fs.writeFileSync(lockPath, 'another-process\n');

        assert.throws(
            () => repository.markProviderSessionsReadOnly('xora-relay'),
            /Another Xora Code process is updating the session index/
        );
        assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('history pages read beyond the legacy 5000-event and 16MiB tail without breaking UTF-8 lines', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-pages-'));
    const appSessionId = '00000000-0000-4000-8000-000000000099';
    const target = path.join(root, `${appSessionId}.jsonl`);
    fs.mkdirSync(root, { recursive: true });
    const padding = '历史记录'.repeat(800);
    const lines = Array.from({ length: 5205 }, (_, index) => JSON.stringify({
        schemaVersion: 1,
        timestamp: '2026-08-13T00:00:00.000Z',
        event: {
            kind: 'text-delta',
            sessionId: appSessionId,
            role: 'assistant',
            text: `${index}:${padding}`
        }
    }));
    fs.writeFileSync(target, `${lines.join('\n')}\n`, { mode: 0o600 });
    assert.ok(fs.statSync(target).size > 16 * 1024 * 1024);
    const repository = new AgentSessionRepository(root);
    try {
        const restored = [];
        let before;
        do {
            const page = repository.readEventPage(appSessionId, { before, limit: 173 });
            restored.unshift(...page.events.map(event => Number(event.text.split(':', 1)[0])));
            before = page.before;
            if (!page.hasMore) break;
            assert.ok(before, 'every non-final page must expose an opaque cursor');
        } while (true);
        assert.equal(restored.length, 5205);
        assert.deepEqual(restored, Array.from({ length: 5205 }, (_, index) => index));
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('newest history page includes unflushed events once and older pages stay durable-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-pending-page-'));
    const appSessionId = '00000000-0000-4000-8000-000000000098';
    const repository = new AgentSessionRepository(root);
    try {
        for (let index = 0; index < 70; index += 1) {
            repository.appendEvent(appSessionId, {
                kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text: String(index)
            });
        }
        repository.appendEvent(appSessionId, {
            kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text: 'pending'
        });
        const newest = repository.readEventPage(appSessionId, { limit: 8 });
        assert.deepEqual(newest.events.map(event => event.text), ['63', '64', '65', '66', '67', '68', '69', 'pending']);
        assert.equal(newest.hasMore, true);
        const older = repository.readEventPage(appSessionId, { before: newest.before, limit: 8 });
        assert.equal(older.events.some(event => event.text === 'pending'), false);
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('history cursors preserve 64-bit Windows file identities without Number truncation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-windows-cursor-'));
    const appSessionId = '00000000-0000-4000-8000-000000000096';
    const target = path.join(root, `${appSessionId}.jsonl`);
    const windowsDevice = '18446744073709551615';
    const windowsInode = '9223372036854775809';
    const line = text => `${JSON.stringify({
        schemaVersion: 1,
        timestamp: '2026-08-13T00:00:00.000Z',
        event: { kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text }
    })}\n`;
    fs.writeFileSync(target, `${line('first')}${line('second')}`, { mode: 0o600 });
    const nativeStatSync = fs.statSync;
    fs.statSync = (file, options) => {
        const stat = nativeStatSync(file, options);
        if (file !== target || !options || options.bigint !== true) return stat;
        return { ...stat, dev: BigInt(windowsDevice), ino: BigInt(windowsInode) };
    };
    const repository = new AgentSessionRepository(root);
    try {
        const newest = repository.readEventPage(appSessionId, { limit: 1 });
        assert.deepEqual(newest.events.map(event => event.text), ['second']);
        assert.ok(newest.before);
        const decoded = JSON.parse(Buffer.from(newest.before, 'base64url').toString('utf8'));
        assert.equal(decoded.device, windowsDevice);
        assert.equal(decoded.inode, windowsInode);

        const older = repository.readEventPage(appSessionId, { before: newest.before, limit: 1 });
        assert.deepEqual(older.events.map(event => event.text), ['first']);
        assert.equal(older.hasMore, false);
    } finally {
        fs.statSync = nativeStatSync;
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('history cursor fails closed when the append-only file identity changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-stale-page-'));
    const appSessionId = '00000000-0000-4000-8000-000000000097';
    const target = path.join(root, `${appSessionId}.jsonl`);
    const line = text => `${JSON.stringify({
        schemaVersion: 1,
        timestamp: '2026-08-13T00:00:00.000Z',
        event: { kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text }
    })}\n`;
    fs.writeFileSync(target, `${line('first')}${line('second')}`, { mode: 0o600 });
    const repository = new AgentSessionRepository(root);
    try {
        const newest = repository.readEventPage(appSessionId, { limit: 1 });
        assert.ok(newest.before);
        const replacement = `${target}.replacement`;
        fs.writeFileSync(replacement, `${line('replacement')}${line('tail')}`, { mode: 0o600 });
        fs.renameSync(replacement, target);
        assert.throws(
            () => repository.readEventPage(appSessionId, { before: newest.before, limit: 1 }),
            /history changed/
        );
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
