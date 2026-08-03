const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { friendlyAgentErrorMessage } = require('../lib/browser/agent-error-labels');
const { AgentViewModel } = require('../lib/browser/agent-view-model');

test('known Provider lifecycle errors become actionable Chinese guidance', () => {
    const restart = friendlyAgentErrorMessage(
        new Error('Restart the runtime for the selected workspace and Provider first.')
    );
    assert.equal(restart, '模型服务刚刚发生变化，Xora Code 正在重新连接，请稍后重新发送。');
    assert.doesNotMatch(restart, /runtime|Provider/i);

    assert.equal(
        friendlyAgentErrorMessage('STALE_PROVIDER_SELECTION: delayed renderer snapshot'),
        '当前模型服务已更新，请稍后重新发送。'
    );

    assert.match(
        friendlyAgentErrorMessage('No credential is available for Relay.'),
        /API 密钥.*重新保存/
    );
    assert.match(
        friendlyAgentErrorMessage('Unauthorized (401): INVALID_API_KEY'),
        /中转站.*Base URL.*模型 ID/
    );
    assert.match(
        friendlyAgentErrorMessage('The application-wide model is not advertised by this ACP runtime.'),
        /Grok Build.*模型 ID/
    );
    assert.equal(
        friendlyAgentErrorMessage('The requested Agent mode is not advertised by this session.'),
        '当前会话不支持该执行方式，请使用“常规”或“持续完成”。'
    );
});

test('unknown errors keep their useful diagnostic text', () => {
    assert.equal(friendlyAgentErrorMessage('fixture-specific failure'), 'fixture-specific failure');
    assert.equal(friendlyAgentErrorMessage(''), '操作未完成，请稍后重试。');
});

test('backend error events never expose known English lifecycle messages in chat', () => {
    const model = new AgentViewModel();
    model.accept({
        kind: 'error',
        code: 'SESSION_CREATE_FAILED',
        message: 'Restart the runtime for the selected workspace and Provider first.',
        recoverable: true
    });

    assert.equal(model.transcript.length, 1);
    assert.equal(model.transcript[0].kind, 'error');
    assert.match(model.transcript[0].text, /正在重新连接/);
    assert.doesNotMatch(model.transcript[0].text, /runtime|Provider/i);
});

test('send, retry and Provider settings use the same friendly error boundary', () => {
    const sourceRoot = path.join(__dirname, '..', 'src', 'browser');
    const agent = fs.readFileSync(path.join(sourceRoot, 'agent-widget.tsx'), 'utf8');
    const management = fs.readFileSync(path.join(sourceRoot, 'agent-management-widget.tsx'), 'utf8');

    assert.match(agent, /const message = friendlyAgentErrorMessage\(error\)/);
    assert.match(agent, /message: friendlyAgentErrorMessage\(event\.message\)/);
    assert.match(management, /无法保存模型服务：\$\{friendlyAgentErrorMessage\(error\)\}/);
    assert.match(management, /无法切换模型服务：\$\{friendlyAgentErrorMessage\(error\)\}/);
    assert.match(management, /无法获取模型：\$\{friendlyAgentErrorMessage\(error\)\}/);
});
