const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { recoverNativeSessionHistory } = require('../lib/electron-main/native-history-recovery');

const target = {
    nativeSessionId: 'native-fixture-only',
    appSessionId: '01234567-1234-4234-9234-012345678901'
};
const timestamp = sequence => `2026-10-14T12:00:${String(sequence).padStart(2, '0')}.000Z`;
const row = (sequence, update, sessionId = target.nativeSessionId) => ({
    timestamp: timestamp(sequence), method: 'session/update', params: { sessionId, update }
});
const chunk = (sessionUpdate, text) => ({ sessionUpdate, content: { type: 'text', text } });
const lines = rows => rows.map(item => JSON.stringify(item)).join('\n');

test('native fixture restores text, thought, terminal tools and turns with original timestamps and stable identities', () => {
    const original = [
        row(0, chunk('user_message_chunk', 'Fixture user ')),
        row(1, chunk('user_message_chunk', 'message')),
        row(2, chunk('agent_thought_chunk', 'Fixture thought ')),
        row(3, chunk('agent_thought_chunk', 'detail')),
        row(4, { sessionUpdate: 'tool_call', toolCallId: 'fixture-tool', title: 'Read fixture', kind: 'read', status: 'in_progress', rawInput: { path: '/fixture/safe.txt' } }),
        row(5, { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fixture result' } }] }),
        row(6, chunk('agent_message_chunk', 'Fixture answer')),
        row(7, { sessionUpdate: 'turn_completed', stopReason: 'end_turn' }),
        row(8, chunk('user_message_chunk', 'Second fixture task')),
        row(9, chunk('agent_message_chunk', 'Second fixture answer')),
        row(10, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' })
    ];
    const source = lines(original);
    const result = recoverNativeSessionHistory(source, target);
    assert.deepEqual(result, recoverNativeSessionHistory(source, target));
    assert.equal(source, lines(original), 'the input native log is immutable');
    assert.equal(result.length, 10, 'an unfinished tool update is held until a terminal update arrives');
    assert.deepEqual(result.map(item => item.timestamp), [0, 1, 2, 3, 5, 6, 7, 8, 9, 10].map(timestamp));
    assert.ok(result.every(item => item.event.sessionId === target.appSessionId));
    const events = result.map(item => item.event);
    assert.equal(events[0].turnId, events[1].turnId, 'adjacent chunks of one user message stay in the same turn');
    assert.ok(events.slice(0, 7).every(item => item.turnId === events[0].turnId));
    assert.notEqual(events[7].turnId, events[0].turnId);
    assert.equal(events[2].thoughtId, events[3].thoughtId);
    assert.equal(events[2].completed, undefined);
    assert.equal(events[3].completed, true);
    assert.deepEqual(events[4], {
        kind: 'tool-call', sessionId: target.appSessionId, turnId: events[0].turnId,
        toolCallId: 'fixture-tool', title: 'Read fixture', toolName: 'read', toolKind: 'read',
        status: 'completed', startedAt: timestamp(4), input: { path: '/fixture/safe.txt' }, output: 'fixture result'
    });
    assert.equal(events[6].stopReason, 'end_turn');
    assert.equal(events[9].stopReason, 'end_turn');
});

test('malformed lines, invalid dates and another native session cannot enter recovery or change its turn IDs', () => {
    const matching = [row(0, chunk('user_message_chunk', 'Only this fixture')), row(2, chunk('agent_message_chunk', 'Only this answer'))];
    const contaminated = [
        '{broken JSON', 'null', '[]', '{}',
        JSON.stringify({ ...row(1, chunk('user_message_chunk', 'wrong date')), timestamp: 'not-a-date' }),
        JSON.stringify({ ...row(1, chunk('user_message_chunk', 'wrong method')), method: 'session/prompt' }),
        lines([matching[0], row(1, chunk('user_message_chunk', 'Other session data'), 'another-native-id'), matching[1]])
    ].join('\n');
    assert.deepEqual(recoverNativeSessionHistory(contaminated, target), recoverNativeSessionHistory(lines(matching), target));
    assert.deepEqual(recoverNativeSessionHistory(lines(matching), { ...target, nativeSessionId: 'no-match' }), []);
    assert.throws(() => recoverNativeSessionHistory('', { ...target, appSessionId: '../unsafe' }), /explicit native\/local session mapping/);
});

test('execution state, approvals, executable requests, images and unfinished tools are excluded', () => {
    const unsafeTypes = ['goal_updated', 'task-contract', 'task_contract', 'plan', 'plan_approval_request', 'permission-request', 'current_mode_update', 'available_commands_update'];
    const source = lines([
        ...unsafeTypes.map((sessionUpdate, index) => row(index, { sessionUpdate, status: 'active', approved: true, command: 'NEVER EXECUTE THIS FIXTURE', entries: [{ text: 'do work' }] })),
        row(20, { sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'fake-base64' } }),
        row(21, { sessionUpdate: 'tool_call', toolCallId: 'unfinished', status: 'in_progress', rawInput: { command: 'do not run' } }),
        { timestamp: timestamp(22), method: 'session/request_permission', params: { sessionId: target.nativeSessionId, options: [{ optionId: 'allow' }] } }
    ]);
    assert.deepEqual(recoverNativeSessionHistory(source, target), []);
    const moduleSource = fs.readFileSync(path.join(__dirname, '../src/electron-main/native-history-recovery.ts'), 'utf8');
    assert.doesNotMatch(moduleSource, /(?:from|require\()['"](?:node:)?(?:fs|child_process)|GrokAgentHostService|sendPrompt\(/);
});

test('failed and rejected tools are historical terminal records and cannot recreate permission actions', () => {
    const result = recoverNativeSessionHistory(lines([
        row(0, chunk('user_message_chunk', 'Fixture tool checks')),
        row(1, { sessionUpdate: 'tool_call_update', toolCallId: 'failed-fixture', status: 'failed', rawOutput: { error: 'fixture failure' } }),
        row(2, { sessionUpdate: 'tool_call_update', toolCallId: 'rejected-fixture', status: 'rejected', options: [{ outcome: 'allow-always' }], _meta: { 'x.ai/tool': { name: 'fixture_tool', kind: 'execute', namespace: 'fixture' } } }),
        row(3, chunk('agent_thought_chunk', 'Trailing historical thought'))
    ]), target);
    assert.equal(result[1].event.status, 'failed');
    assert.equal(result[1].event.output, '{"error":"fixture failure"}');
    assert.equal(result[2].event.status, 'rejected');
    assert.equal(result[2].event.toolName, 'fixture_tool');
    assert.equal(result[2].event.options, undefined);
    assert.equal(result[2].event._meta, undefined);
    assert.equal(result[3].event.completed, true, 'a recovered thought never appears to be running');
});

test('native Grok 1.x Unix-second timestamps preserve visible message history', () => {
    const target = { nativeSessionId: 'native-1', appSessionId: '11111111-1111-4111-8111-111111111111' };
    const jsonl = [1791945710, -1, 1791945710000].map(timestamp => JSON.stringify({
        timestamp, method: 'session/update', params: { sessionId: target.nativeSessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fixture only' } } }
    })).join('\n');
    const result = recoverNativeSessionHistory(jsonl, target);
    assert.equal(result.length, 1);
    assert.equal(result[0].timestamp, '2026-10-14T02:41:50.000Z');
    assert.equal(result[0].event.role, 'user');
});

test('Grok extension turn completion is restored as an inert terminal event', () => {
    const target = { nativeSessionId: 'native-1', appSessionId: '11111111-1111-4111-8111-111111111111' };
    const rows = [
        { timestamp: 1791945710, method: 'session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fixture' } } } },
        { timestamp: 1791945711, method: '_x.ai/session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } } },
        { timestamp: 1791945712, method: '_x.ai/session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'goal_updated', status: 'active' } } }
    ];
    const result = recoverNativeSessionHistory(rows.map(row => JSON.stringify(row)).join('\n'), target);
    assert.deepEqual(result.map(row => row.event.kind), ['text-delta', 'turn-completed']);
    assert.equal(result[1].event.turnId, result[0].event.turnId);
    assert.equal(result[1].event.stopReason, 'end_turn');
});
