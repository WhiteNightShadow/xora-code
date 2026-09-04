const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    AgentSessionRepository,
    SessionNotFoundError,
    SessionPromptConflictError
} = require('../lib/electron-main/session-repository');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

function deletionHost(repository, promptTokens = new Map()) {
    const host = Object.create(GrokAgentHostService.prototype);
    host.sessions = repository;
    host.activePrompts = new Map();
    host.promptClaimTokens = promptTokens;
    host.pendingPromptTerminals = new Map();
    host.pendingPermissions = new Map();
    host.loadedSessionIds = new Set();
    host.knownSessionIds = new Set();
    host.contextEventHighwaters = new Map();
    host.restoringSessionCounts = new Map();
    host.acpSessionLookup = new Map();
    host.currentSecrets = [];
    host.phase = 'stopped';
    host.acp = undefined;
    host.supervisor = { running: false };
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    return host;
}

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

test('session index signatures preserve 64-bit NTFS identities without Number aliasing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-ntfs-signature-'));
    const indexPath = path.join(root, 'index.json');
    const base = {
        schemaVersion: 1,
        sessions: [{
            appSessionId: '00000000-0000-4000-8000-000000000021',
            acpSessionId: 'acp-a',
            title: 'A',
            workspaceRoot: 'C:\\fixture',
            providerId: 'grok-subscription',
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z',
            status: 'idle'
        }]
    };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify(base)}\n`);
    const nativeStatSync = fs.statSync;
    let identity = 9223372036854775808n;
    fs.statSync = (file, options) => {
        const stat = nativeStatSync(file, options);
        if (path.resolve(String(file)) !== path.resolve(indexPath) || !options || options.bigint !== true) return stat;
        return {
            ...stat,
            dev: 18446744073709551615n,
            ino: identity,
            size: 4096n,
            mtimeNs: 1000000000000000001n,
            ctimeNs: 1000000000000000002n
        };
    };
    const repository = new AgentSessionRepository(root);
    try {
        assert.equal(repository.list()[0].title, 'A');
        fs.writeFileSync(indexPath, `${JSON.stringify({
            ...base,
            sessions: [{ ...base.sessions[0], title: 'B' }]
        })}\n`);
        identity += 1n;
        assert.equal(repository.list()[0].title, 'B',
            'adjacent NTFS file ids above 2^53 must not alias in the cache');
    } finally {
        fs.statSync = nativeStatSync;
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an index writer invalidates a matching cache signature and merges the authoritative disk snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-authoritative-lock-'));
    const indexPath = path.join(root, 'index.json');
    const first = new AgentSessionRepository(root);
    const second = new AgentSessionRepository(root);
    const nativeStatSync = fs.statSync;
    try {
        const original = first.create({
            acpSessionId: 'acp-a',
            title: 'A',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        fs.statSync = (file, options) => {
            const stat = nativeStatSync(file, options);
            if (path.resolve(String(file)) !== path.resolve(indexPath) || !options || options.bigint !== true) return stat;
            return {
                ...stat,
                dev: 1n,
                ino: 2n,
                size: 3n,
                mtimeNs: 4n,
                ctimeNs: 5n
            };
        };
        second.list();
        first.update(original.appSessionId, { title: 'B', model: 'grok-4.6' });
        second.update(original.appSessionId, { status: 'completed' });

        fs.statSync = nativeStatSync;
        const merged = first.get(original.appSessionId);
        assert.equal(merged.title, 'B');
        assert.equal(merged.model, 'grok-4.6');
        assert.equal(merged.status, 'completed');
    } finally {
        fs.statSync = nativeStatSync;
        first.dispose();
        second.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a transient ENOENT after an observed index is retried instead of becoming an empty store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-index-retry-'));
    const indexPath = path.join(root, 'index.json');
    const repository = new AgentSessionRepository(root);
    const created = repository.create({
        acpSessionId: 'acp-a',
        title: 'A',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });
    const nativeStatSync = fs.statSync;
    let missingReads = 2;
    fs.statSync = (file, options) => {
        if (path.resolve(String(file)) === path.resolve(indexPath) && missingReads-- > 0) {
            const error = new Error('transient replacement gap');
            error.code = 'ENOENT';
            throw error;
        }
        return nativeStatSync(file, options);
    };
    try {
        const updated = repository.update(created.appSessionId, { title: 'survived' });
        assert.equal(updated.title, 'survived');
        assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).sessions.length, 1);
    } finally {
        fs.statSync = nativeStatSync;
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('prompt claim fails closed after cross-window deletion and protects a running owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-prompt-claim-'));
    const owner = new AgentSessionRepository(root);
    const peer = new AgentSessionRepository(root);
    try {
        const removed = owner.create({
            acpSessionId: 'acp-removed',
            title: 'removed',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        peer.list();
        assert.equal(owner.delete(removed.appSessionId), true);
        assert.throws(
            () => peer.claimPrompt(removed.appSessionId),
            error => error instanceof SessionNotFoundError
                && error.code === 'SESSION_NOT_FOUND'
                && error.message.startsWith('SESSION_NOT_FOUND:')
        );

        const live = owner.create({
            acpSessionId: 'acp-live',
            title: 'live',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const claimed = peer.claimPrompt(live.appSessionId);
        assert.equal(claimed.record.status, 'running');
        assert.equal(JSON.stringify(peer.list()).includes('_promptClaim'), false,
            'owner ids and CAS tokens remain Electron-main-only');
        assert.equal(JSON.stringify(peer.list()).includes(claimed.token), false);
        assert.throws(() => owner.delete(live.appSessionId), SessionPromptConflictError);
        peer.finishPrompt(live.appSessionId, claimed.token, 'completed');
        assert.equal(owner.delete(live.appSessionId), true);
    } finally {
        owner.dispose();
        peer.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an owner can settle and delete its orphan while a foreign live claim remains protected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-owned-orphan-'));
    const owner = new AgentSessionRepository(root);
    const peer = new AgentSessionRepository(root);
    try {
        const owned = owner.create({
            acpSessionId: 'acp-owned-orphan',
            title: 'owned orphan',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        owner.claimPrompt(owned.appSessionId);
        assert.throws(
            () => peer.finishOwnedPrompt(owned.appSessionId, 'cancelled'),
            SessionPromptConflictError,
            'a peer must never settle another repository owner\'s live claim'
        );
        const settled = owner.finishOwnedPrompt(owned.appSessionId, 'cancelled');
        assert.equal(settled.status, 'cancelled');
        assert.equal(owner.promptClaimOwnership(owned.appSessionId), 'none');
        assert.equal(owner.delete(owned.appSessionId), true);
        assert.equal(owner.get(owned.appSessionId), undefined);
    } finally {
        owner.dispose();
        peer.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('service deletion releases an owned crash orphan but refuses a foreign live claim', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-service-delete-'));
    const owner = new AgentSessionRepository(root);
    const peer = new AgentSessionRepository(root);
    try {
        const owned = owner.create({
            acpSessionId: 'acp-service-owned',
            title: 'service owned',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const ownedClaim = owner.claimPrompt(owned.appSessionId);
        const ownerHost = deletionHost(owner, new Map([[owned.appSessionId, ownedClaim.token]]));
        await ownerHost.deleteSession(owned.appSessionId);
        assert.equal(owner.get(owned.appSessionId), undefined);

        const live = owner.create({
            acpSessionId: 'acp-service-live',
            title: 'service live',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const liveClaim = owner.claimPrompt(live.appSessionId);
        const liveHost = deletionHost(owner, new Map([[live.appSessionId, liveClaim.token]]));
        let rejectLive;
        const livePromise = new Promise((_resolve, reject) => { rejectLive = reject; });
        const liveHandle = {
            promise: livePromise,
            cancel: async () => {
                liveHost.activePrompts.delete(live.appSessionId);
                rejectLive(new Error('cancelled'));
            }
        };
        liveHost.activePrompts.set(live.appSessionId, liveHandle);
        await liveHost.deleteSession(live.appSessionId);
        assert.equal(owner.get(live.appSessionId), undefined,
            'owned live deletion must settle after cancellation before removing history');

        const foreign = owner.create({
            acpSessionId: 'acp-service-foreign',
            title: 'service foreign',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        owner.claimPrompt(foreign.appSessionId);
        const peerHost = deletionHost(peer);
        await assert.rejects(
            peerHost.deleteSession(foreign.appSessionId),
            SessionPromptConflictError
        );
        assert.equal(peer.get(foreign.appSessionId)?.status, 'running');
    } finally {
        owner.dispose();
        peer.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('service deletion waits for cancellation delivery and retains history on failure or timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-delete-delivery-'));
    const repository = new AgentSessionRepository(root);
    try {
        const createRunning = suffix => {
            const created = repository.create({
                acpSessionId: `acp-${suffix}`,
                title: suffix,
                workspaceRoot: '/fixture',
                providerId: 'grok-subscription'
            });
            const claim = repository.claimPrompt(created.appSessionId);
            return { created, claim };
        };
        const attachHandle = (host, created, claim, transport) => {
            let rejectPrompt;
            const promise = new Promise((_resolve, reject) => { rejectPrompt = reject; });
            promise.catch(() => {
                if (repository.get(created.appSessionId)?.status === 'running') {
                    repository.finishPrompt(created.appSessionId, claim.token, 'cancelled');
                    host.promptClaimTokens.delete(created.appSessionId);
                }
                host.activePrompts.delete(created.appSessionId);
            });
            host.activePrompts.set(created.appSessionId, {
                promise,
                cancel: () => {
                    rejectPrompt(new Error('cancelled'));
                    return transport;
                }
            });
        };

        let resolveDelivery;
        const delivered = new Promise(resolve => { resolveDelivery = resolve; });
        const delayed = createRunning('delayed-delivery');
        const delayedHost = deletionHost(repository, new Map([[delayed.created.appSessionId, delayed.claim.token]]));
        delayedHost.phase = 'ready';
        delayedHost.acp = {};
        delayedHost.supervisor.running = true;
        attachHandle(delayedHost, delayed.created, delayed.claim, delivered);
        const deleting = delayedHost.deleteSession(delayed.created.appSessionId);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(repository.get(delayed.created.appSessionId),
            'history must remain while ACP cancellation delivery is pending');
        resolveDelivery();
        await deleting;
        assert.equal(repository.get(delayed.created.appSessionId), undefined);

        const failed = createRunning('failed-delivery');
        const failedHost = deletionHost(repository, new Map([[failed.created.appSessionId, failed.claim.token]]));
        failedHost.phase = 'ready';
        failedHost.acp = {};
        failedHost.supervisor.running = true;
        attachHandle(failedHost, failed.created, failed.claim, Promise.reject(new Error('stdin closed')));
        await assert.rejects(failedHost.deleteSession(failed.created.appSessionId), /stdin closed/);
        assert.ok(repository.get(failed.created.appSessionId));
        await assert.rejects(
            failedHost.deleteSession(failed.created.appSessionId),
            /still confirming|cancellation was not confirmed/
        );

        const timedOut = createRunning('timeout-delivery');
        const timeoutHost = deletionHost(repository, new Map([[timedOut.created.appSessionId, timedOut.claim.token]]));
        timeoutHost.phase = 'ready';
        timeoutHost.acp = {};
        timeoutHost.supervisor.running = true;
        timeoutHost.deleteCancellationTimeoutMs = () => 10;
        attachHandle(timeoutHost, timedOut.created, timedOut.claim, new Promise(() => undefined));
        await assert.rejects(
            timeoutHost.deleteSession(timedOut.created.appSessionId),
            /发送超时/
        );
        assert.ok(repository.get(timedOut.created.appSessionId));
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('draining runtime never reclassifies a self-owned live claim as an orphan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-draining-delete-'));
    const repository = new AgentSessionRepository(root);
    try {
        const created = repository.create({
            acpSessionId: 'acp-draining',
            title: 'draining',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const claim = repository.claimPrompt(created.appSessionId);
        const host = deletionHost(repository, new Map([[created.appSessionId, claim.token]]));
        host.phase = 'draining';
        host.acp = {};
        host.supervisor.running = true;

        await assert.rejects(
            host.deleteSession(created.appSessionId),
            /runtime may still be executing/
        );
        assert.equal(repository.get(created.appSessionId)?.status, 'running');
        assert.equal(repository.promptClaimOwnership(created.appSessionId), 'owned');
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Provider invalidation defers read-only state until the prompt owner releases its CAS token', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-claim-invalidation-'));
    const owner = new AgentSessionRepository(root);
    const peer = new AgentSessionRepository(root);
    try {
        const session = owner.create({
            acpSessionId: 'acp-live',
            title: 'live',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const claim = owner.claimPrompt(session.appSessionId);
        const invalidated = peer.markProviderSessionsReadOnly('grok-subscription');
        assert.equal(invalidated[0].status, 'running', 'another process cannot release the active claim');
        assert.throws(
            () => peer.update(session.appSessionId, { status: 'read-only' }),
            SessionPromptConflictError
        );
        const metadataOnly = peer.update(session.appSessionId, { sidecarVersion: '0.2.102' });
        assert.equal(metadataOnly.status, 'running', 'session/load metadata cannot reset a foreign running claim');
        assert.equal(peer.promptClaimOwnership(session.appSessionId), 'foreign');
        assert.throws(
            () => peer.update(session.appSessionId, { status: 'idle' }),
            SessionPromptConflictError,
            'session/load cannot unconditionally turn another window idle'
        );
        assert.throws(
            () => peer.finishPrompt(session.appSessionId, claim.token, 'completed'),
            SessionPromptConflictError,
            'a token is also bound to its repository owner'
        );
        const finished = owner.finishPrompt(session.appSessionId, claim.token, 'completed');
        assert.equal(finished.status, 'read-only', 'deferred invalidation wins when the owner finishes');
    } finally {
        owner.dispose();
        peer.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a disposed same-process owner leaves a recoverable failed claim without replaying its prompt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-stale-owner-'));
    const crashed = new AgentSessionRepository(root);
    const session = crashed.create({
        acpSessionId: 'acp-crashed',
        title: 'crashed',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });
    crashed.claimPrompt(session.appSessionId);
    crashed.dispose();
    const recovered = new AgentSessionRepository(root);
    try {
        const record = recovered.reconcileStalePromptClaim(session.appSessionId);
        assert.equal(record.status, 'failed');
        assert.equal(recovered.promptClaimOwnership(session.appSessionId), 'none');
        assert.equal(recovered.readEvents(session.appSessionId).length, 0,
            'recovery changes only ownership state and never synthesizes/replays a prompt');
    } finally {
        recovered.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an ancient claim owned by a still-live foreign PID remains fail-closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-live-foreign-owner-'));
    const indexPath = path.join(root, 'index.json');
    const appSessionId = '00000000-0000-4000-8000-000000000029';
    fs.writeFileSync(indexPath, `${JSON.stringify({
        schemaVersion: 1,
        sessions: [{
            appSessionId,
            acpSessionId: 'acp-foreign',
            title: 'foreign',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            createdAt: '2000-01-01T00:00:00.000Z',
            updatedAt: '2000-01-01T00:00:00.000Z',
            status: 'running',
            _promptClaim: {
                ownerId: 'foreign-owner',
                token: 'foreign-token',
                processId: process.ppid,
                acquiredAt: '2000-01-01T00:00:00.000Z'
            }
        }]
    })}\n`, { mode: 0o600 });
    const repository = new AgentSessionRepository(root);
    try {
        assert.equal(repository.promptClaimOwnership(appSessionId), 'foreign');
        assert.throws(() => repository.claimPrompt(appSessionId), SessionPromptConflictError);
        assert.throws(() => repository.delete(appSessionId), SessionPromptConflictError);
        assert.equal(repository.get(appSessionId)?.status, 'running');
    } finally {
        repository.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a stale writer tmp cannot permanently block a genuinely fresh session index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-stale-tmp-'));
    const stale = path.join(root, 'index.json.999.deadbeef.tmp');
    fs.writeFileSync(stale, '{"partial":true}', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, old, old);
    const repository = new AgentSessionRepository(root);
    try {
        const session = repository.create({
            acpSessionId: 'acp-fresh',
            title: 'fresh',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        assert.equal(repository.get(session.appSessionId)?.title, 'fresh');
        assert.equal(fs.existsSync(stale), false);
    } finally {
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

test('a prompt owner retries a short index-lock collision before publishing its terminal state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-session-lock-retry-'));
    const lockPath = path.join(root, '.index.lock');
    const repository = new AgentSessionRepository(root);
    const originalOpenSync = fs.openSync;
    const originalStatSync = fs.statSync;
    try {
        const created = repository.create({
            acpSessionId: 'acp-lock-retry',
            title: 'Lock retry',
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        });
        const claim = repository.claimPrompt(created.appSessionId);
        let collisions = 0;
        fs.openSync = function (...args) {
            if (path.resolve(String(args[0])) === path.resolve(lockPath)
                && args[1] === 'wx'
                && collisions < 3) {
                collisions += 1;
                const error = new Error('synthetic peer lock');
                error.code = 'EEXIST';
                throw error;
            }
            return originalOpenSync.apply(this, args);
        };
        fs.statSync = function (...args) {
            if (path.resolve(String(args[0])) === path.resolve(lockPath) && collisions <= 3) {
                return { mtimeMs: Date.now() };
            }
            return originalStatSync.apply(this, args);
        };

        const finished = repository.finishPrompt(created.appSessionId, claim.token, 'completed');

        assert.equal(collisions, 3);
        assert.equal(finished.status, 'completed');
        assert.equal(repository.get(created.appSessionId).status, 'completed');
    } finally {
        fs.openSync = originalOpenSync;
        fs.statSync = originalStatSync;
        repository.dispose();
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
