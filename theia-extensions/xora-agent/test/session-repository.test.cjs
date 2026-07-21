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
