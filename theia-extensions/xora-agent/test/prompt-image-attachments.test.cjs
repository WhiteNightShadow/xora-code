const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const {
    MAX_PROMPT_IMAGE_BYTES,
    validatePromptImageAttachments
} = require('../lib/electron-main/prompt-image-attachments');
const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function attachment(mimeType = 'image/png', contents = PNG_SIGNATURE, name) {
    return {
        mimeType,
        data: contents.toString('base64'),
        ...(name ? { name } : {})
    };
}

function hostHarness(imageCapability) {
    const host = Object.create(GrokAgentHostService.prototype);
    const session = {
        appSessionId: 'app-session',
        acpSessionId: 'acp-session',
        title: 'fixture',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
        status: 'idle'
    };
    const events = [];
    const requests = [];
    const acp = {
        startRequest(method, params, options) {
            requests.push({ method, params, options });
            return { promise: Promise.resolve({ stopReason: 'end_turn' }), cancel: async () => undefined };
        }
    };
    host.requireReady = () => acp;
    host.sessions = {
        get: id => id === session.appSessionId ? { ...session } : undefined,
        update: (id, patch) => {
            assert.equal(id, session.appSessionId);
            Object.assign(session, patch);
            return { ...session };
        },
        flushEvents: () => undefined
    };
    host.workspaceRoot = session.workspaceRoot;
    host.providerId = session.providerId;
    host.activeSessionId = session.appSessionId;
    host.loadedSessionIds = new Set([session.appSessionId]);
    host.activePrompts = new Map();
    host.capabilities = {
        protocolVersion: 1,
        loadSession: true,
        prompt: { image: imageCapability, audio: false, embeddedContext: true },
        mcp: { http: false, sse: false },
        authMethods: []
    };
    host.emit = event => events.push(event);
    host.emitError = (code, error, recoverable, sessionId) => events.push({
        kind: 'error', code, message: String(error), recoverable, sessionId
    });
    return { host, events, requests };
}

test('image capability false fails closed before creating an ACP request or history event', async () => {
    const { host, events, requests } = hostHarness(false);
    await assert.rejects(
        host.sendPrompt({ sessionId: 'app-session', text: '看图', attachments: [attachment()] }),
        /does not support image prompts/
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(events, []);
});

test('image capability true emits exact ACP image blocks and persists metadata only', async () => {
    const image = attachment('image/png', PNG_SIGNATURE, '截图.png');
    const { host, events, requests } = hostHarness(true);

    await host.sendPrompt({ sessionId: 'app-session', text: '解释这张图', attachments: [image] });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'session/prompt');
    assert.deepEqual(requests[0].params, {
        sessionId: 'acp-session',
        prompt: [
            { type: 'text', text: '解释这张图' },
            { type: 'image', mimeType: 'image/png', data: image.data }
        ]
    });
    const userEvent = events.find(event => event.kind === 'text-delta' && event.role === 'user');
    assert.deepEqual(userEvent, {
        kind: 'text-delta',
        sessionId: 'app-session',
        role: 'user',
        text: '解释这张图',
        attachments: [{
            kind: 'image',
            mimeType: 'image/png',
            byteSize: PNG_SIGNATURE.length,
            sha256: crypto.createHash('sha256').update(PNG_SIGNATURE).digest('hex'),
            name: '截图.png'
        }]
    });
    assert.equal(JSON.stringify(userEvent).includes(image.data), false);
});

test('validator rejects non-canonical base64, unsupported MIME and MIME magic mismatch', () => {
    assert.throws(
        () => validatePromptImageAttachments([{ ...attachment(), data: `${attachment().data}\n` }]),
        /canonical base64/
    );
    assert.throws(
        () => validatePromptImageAttachments([{ mimeType: 'image/gif', data: 'R0lGODlh' }]),
        /Only PNG, JPEG and WebP/
    );
    assert.throws(
        () => validatePromptImageAttachments([attachment('image/jpeg', PNG_SIGNATURE)]),
        /does not match its declared MIME type/
    );
});

test('validator enforces count, per-image and aggregate decoded byte limits', () => {
    assert.throws(
        () => validatePromptImageAttachments(Array.from({ length: 5 }, () => attachment())),
        /at most 4 images/
    );

    const oversized = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1);
    PNG_SIGNATURE.copy(oversized);
    assert.throws(
        () => validatePromptImageAttachments([attachment('image/png', oversized)]),
        /Each image attachment must be 5 MiB or smaller/
    );

    const first = Buffer.alloc(3 * 1024 * 1024);
    PNG_SIGNATURE.copy(first);
    const second = Buffer.alloc(3 * 1024 * 1024);
    JPEG_SIGNATURE.copy(second);
    assert.throws(
        () => validatePromptImageAttachments([
            attachment('image/png', first),
            attachment('image/jpeg', second)
        ]),
        /5 MiB or smaller in total/
    );
});

test('fake service advertises images and exposes only attachment summaries to clients', async () => {
    const service = new FakeAgentHostService();
    const events = [];
    service.setClient({ onAgentEvent: event => events.push(event) });
    await service.setWorkspaceRoot('/fixture');
    await service.synchronizeWorkspaceTrust({ workspaceRoots: ['/fixture'], trusted: true });
    const snapshot = await service.startRuntime({ workspaceRoot: '/fixture', providerId: 'grok-subscription' });
    assert.equal(snapshot.capabilities.prompt.image, true);
    await service.setPermissionMode('full-access');
    const session = await service.createSession({
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });
    events.length = 0;
    const image = attachment();

    await service.sendPrompt({ sessionId: session.appSessionId, text: '', attachments: [image] });

    const userEvent = events.find(event => event.kind === 'text-delta' && event.role === 'user');
    assert.equal(userEvent.attachments[0].byteSize, PNG_SIGNATURE.length);
    assert.equal(JSON.stringify(events).includes(image.data), false);
});
