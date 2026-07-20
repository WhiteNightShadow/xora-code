const assert = require('node:assert/strict');
const test = require('node:test');

const {
    contextTotalTokens,
    parseAcpSessionContextEnvelope,
    parseAutoCompaction,
    parsePromptContextFallback,
    parseXaiSessionContextEnvelope
} = require('../lib/electron-main/context-telemetry');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

function session() {
    return {
        appSessionId: 'app-a',
        acpSessionId: 'acp-a',
        title: 'A',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        model: 'grok',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        status: 'running'
    };
}

function hostHarness() {
    const host = Object.create(GrokAgentHostService.prototype);
    const record = session();
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        appendEvent: () => undefined
    };
    host.acpSessionLookup = new Map([['acp-a', 'app-a']]);
    host.restoringSessionCounts = new Map();
    host.sessionContexts = new Map();
    host.contextEventHighwaters = new Map();
    host.models = [{ id: 'grok', name: 'Grok', contextWindow: 200000 }];
    host.selectedModel = 'grok';
    const emitted = [];
    host.emit = event => emitted.push(event);
    return { host, emitted };
}

test('fixed Grok extension envelopes are parsed narrowly and replay is explicit', () => {
    const direct = parseXaiSessionContextEnvelope('x.ai/session_notification', {
        sessionId: 'acp-a',
        update: {
            sessionUpdate: 'auto_compact_started',
            tokens_used: 170000,
            context_window: 200000,
            percentage: 85,
            ignored: { secret: true }
        },
        _meta: { totalTokens: 170000, eventId: 'acp-a-42' }
    });
    assert.equal(direct.sessionId, 'acp-a');
    assert.equal(direct.eventSequence, 42);
    assert.equal(direct.replay, false);

    const wrapped = parseXaiSessionContextEnvelope('_x.ai/session_notification', {
        method: 'x.ai/session_notification',
        params: {
            sessionId: 'acp-a',
            update: { sessionUpdate: 'auto_compact_cancelled', reason: 'user' },
            _meta: { isReplay: true }
        }
    });
    assert.equal(wrapped.replay, true);
    assert.equal(parseXaiSessionContextEnvelope('_x.ai/session_notification', {
        method: 'malicious/extension',
        params: { sessionId: 'acp-a', update: {} }
    }), undefined);
});

test('only context totalTokens is accepted; billed usage is never context', () => {
    const fallback = parsePromptContextFallback({
        _meta: {
            sessionId: 'acp-a',
            totalTokens: 93210,
            modelId: 'grok',
            usage: { totalTokens: 999999, inputTokens: 900000 }
        }
    });
    assert.deepEqual(fallback, {
        sessionId: 'acp-a',
        totalTokens: 93210,
        modelId: 'grok',
        billedUsagePresent: true
    });
    assert.equal(parsePromptContextFallback({ _meta: { usage: { totalTokens: 999999 } } }).totalTokens, undefined);
    assert.equal(contextTotalTokens({ totalTokens: 1200, usage: { totalTokens: 999999 } }), 1200);
    assert.equal(contextTotalTokens({ usage: { totalTokens: 999999 } }), undefined);
});

test('automatic compaction accepts only complete known lifecycle shapes', () => {
    assert.deepEqual(parseAutoCompaction({
        sessionUpdate: 'auto_compact_started',
        tokens_used: 170000,
        context_window: 200000,
        percentage: 85,
        reason: 'Context window 85% full'
    }), { kind: 'started', tokensUsed: 170000, contextWindow: 200000, percentage: 85 });
    assert.deepEqual(parseAutoCompaction({
        sessionUpdate: 'auto_compact_completed',
        tokens_before: 170000,
        tokens_after: 42000,
        elapsed_ms: 312
    }), { kind: 'completed', tokensBefore: 170000, tokensAfter: 42000, elapsedMs: 312 });
    assert.equal(parseAutoCompaction({ sessionUpdate: 'auto_compact_started', tokens_used: 1 }), undefined);
    assert.equal(parseAutoCompaction({ sessionUpdate: 'future_compaction', totalTokens: 1 }), undefined);
});

test('host isolates context by ACP session, drops replay/stale events and counts completed compactions', () => {
    const { host, emitted } = hostHarness();
    host.acceptXaiSessionContext({
        sessionId: 'unknown-acp',
        update: { sessionUpdate: 'auto_compact_failed', error: 'ignored' }
    }, 'x.ai/session_notification');
    host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'auto_compact_started', tokens_used: 170000, context_window: 200000, percentage: 85 },
        _meta: { isReplay: true, eventId: 'acp-a-40' }
    }, 'x.ai/session_notification');
    assert.equal(emitted.length, 0);

    host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'auto_compact_started', tokens_used: 170000, context_window: 200000, percentage: 85 },
        _meta: { totalTokens: 170000, eventId: 'acp-a-42' }
    }, 'x.ai/session_notification');
    assert.equal(emitted.at(-1).context.compactionStatus, 'running');
    assert.equal(emitted.at(-1).context.usagePercent, 85);

    host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'auto_compact_completed', tokens_before: 170000, tokens_after: 42000, elapsed_ms: 312 },
        _meta: { totalTokens: 42000, eventId: 'acp-a-43' }
    }, 'x.ai/session_notification');
    const completed = emitted.at(-1).context;
    assert.equal(completed.compactionStatus, 'idle');
    assert.equal(completed.compactionCount, 1);
    assert.deepEqual(completed.lastCompaction, { tokensBefore: 170000, tokensAfter: 42000, elapsedMs: 312 });

    const eventCount = emitted.length;
    host.acceptXaiSessionContext({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'auto_compact_failed', error: 'stale' },
        _meta: { eventId: 'acp-a-41' }
    }, 'x.ai/session_notification');
    assert.equal(emitted.length, eventCount);
});

test('standard ACP metadata and prompt fallback retain strict session mapping', () => {
    const envelope = parseAcpSessionContextEnvelope({
        sessionId: 'acp-a',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
        _meta: { totalTokens: 75000, eventId: 'acp-a-7' }
    });
    assert.equal(contextTotalTokens(envelope.meta), 75000);

    const { host, emitted } = hostHarness();
    host.acceptPromptContextFallback('app-a', 'acp-a', {
        _meta: { sessionId: 'wrong-acp', totalTokens: 80000, modelId: 'grok' }
    });
    assert.equal(emitted.length, 0);
    host.acceptPromptContextFallback('app-a', 'acp-a', {
        _meta: { sessionId: 'acp-a', usage: { totalTokens: 80000 } }
    });
    assert.equal(emitted.length, 0, 'billing-only usage must not create context state');
    host.acceptPromptContextFallback('app-a', 'acp-a', {
        _meta: { sessionId: 'acp-a', totalTokens: 80000, modelId: 'grok', usage: { totalTokens: 90000 } }
    });
    assert.equal(emitted.at(-1).context.totalTokens, 80000);
    assert.equal(emitted.at(-1).context.usagePercent, 40);
});
