const assert = require('node:assert/strict');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

function hostHarness() {
    const host = Object.create(GrokAgentHostService.prototype);
    const ipc = [];
    const history = [];
    host.pendingAssistantTextDeltas = new Map();
    host.assistantStreamsStarted = new Set();
    host.pendingThoughtDeltas = new Map();
    host.activeThoughtStreams = new Map();
    host.thoughtStreamsStarted = new Set();
    host.activeTurnIds = new Map([['a', 'turn-a']]);
    host.currentSecrets = [];
    host.knownSessionIds = new Set(['a']);
    host.client = { onAgentEvent: event => ipc.push(event) };
    host.sessions = { appendEvent: (sessionId, event) => history.push({ sessionId, event }) };
    return { host, ipc, history };
}

test('thought chunks are isolated, batched and closed before the final answer', async () => {
    const { host, ipc, history } = hostHarness();
    host.acceptThoughtDelta('a', '先检查', 'message-1');
    host.acceptThoughtDelta('a', '项目，', 'message-1');
    host.acceptThoughtDelta('a', '再验证。', 'message-1');

    assert.equal(ipc.length, 1, 'the first thought fragment remains latency-first');
    assert.equal(ipc[0].kind, 'thought-delta');
    assert.equal(ipc[0].text, '先检查');

    host.emit({ kind: 'text-delta', sessionId: 'a', role: 'assistant', text: '处理完成。' });

    assert.deepEqual(ipc.map(event => event.kind), [
        'thought-delta',
        'thought-delta',
        'thought-delta',
        'text-delta'
    ]);
    assert.equal(ipc[1].text, '项目，再验证。');
    assert.equal(ipc[2].completed, true);
    assert.equal(ipc[2].text, '');
    assert.equal(ipc[2].turnId, 'turn-a');
    assert.ok(Number.isFinite(ipc[2].elapsedMs));
    assert.equal(ipc[3].text, '处理完成。');
    assert.deepEqual(history.map(item => item.event.kind), ipc.map(event => event.kind));

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(ipc.length, 4, 'a cleared thought timer must never duplicate history');
});

test('a new ACP thought message closes the previous thought as an independent disclosure', () => {
    const { host, ipc } = hostHarness();
    host.acceptThoughtDelta('a', '第一段', 'one');
    host.acceptThoughtDelta('a', '第二段', 'two');
    host.emit({ kind: 'turn-completed', sessionId: 'a', stopReason: 'end_turn' });

    const terminalIds = ipc.filter(event => event.kind === 'thought-delta' && event.completed)
        .map(event => event.thoughtId);
    assert.equal(terminalIds.length, 2);
    assert.notEqual(terminalIds[0], terminalIds[1]);
    assert.equal(ipc.at(-1).kind, 'turn-completed');
});

test('legacy thought chunks without message ids survive unrelated runtime snapshots', () => {
    const { host, ipc } = hostHarness();
    host.acceptThoughtDelta('a', '先定位');
    host.emit({ kind: 'snapshot', snapshot: { phase: 'ready', sessions: [] } }, false);
    host.acceptThoughtDelta('a', '，再验证');
    host.emit({ kind: 'turn-completed', sessionId: 'a', stopReason: 'end_turn' });

    const thoughts = ipc.filter(event => event.kind === 'thought-delta');
    assert.equal(new Set(thoughts.map(event => event.thoughtId)).size, 1);
    assert.equal(thoughts.filter(event => event.completed).length, 1);
    assert.equal(thoughts.filter(event => !event.completed).map(event => event.text).join(''), '先定位，再验证');
});
