const assert = require('node:assert/strict');
const test = require('node:test');

const {
    agentModelChoiceGroups,
    decodeAgentModelChoice,
    PROVIDER_DEFAULT_MODEL_CHOICE_ID,
    selectedAgentModelChoice,
    XAI_MANAGED_MODEL_ID
} = require('../lib/browser/agent-model-options');

function snapshot(providerId, models = [], selectedModel) {
    return {
        phase: 'ready',
        workspaceAttached: true,
        workspaceTrusted: true,
        providerId,
        grokSubscriptionAuthStatus: 'unknown',
        models,
        selectedModel,
        sessions: [],
        permissionMode: 'request-approval'
    };
}

const xai = {
    id: 'xai-api-key',
    name: 'xAI / Grok API',
    kind: 'xai-api-key',
    protocol: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.5',
    secretRef: 'provider:xai-api-key',
    credentialConfigured: true
};

const relay = {
    id: 'xora-relay',
    name: '横迪AI',
    kind: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://relay.example.invalid/v1',
    model: 'grok-4.5',
    secretRef: 'provider:xora-relay',
    credentialConfigured: true
};

const subscription = { id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription' };

test('the Agent selector exposes only the current service and keeps safe local catalog ids', () => {
    const xaiRuntime = snapshot('xai-api-key', [
        { id: XAI_MANAGED_MODEL_ID, name: 'xAI / Grok API' },
        { id: 'xora-relay', name: '横迪AI' },
        { id: 'grok-4.5', name: 'Grok 4.5' }
    ], XAI_MANAGED_MODEL_ID);
    const xaiGroups = agentModelChoiceGroups([subscription, xai, relay], xaiRuntime);
    const relayRuntime = snapshot(relay.id, [{ id: relay.id, name: relay.name }], relay.id);
    const relayGroups = agentModelChoiceGroups([subscription, xai, relay], relayRuntime);
    const relayChoice = relayGroups[0].choices[0];

    assert.deepEqual(xaiGroups, [], 'the retired built-in service is never rendered');
    assert.deepEqual(relayGroups.map(group => group.providerId), [relay.id]);
    assert.equal(relayChoice.modelId, relay.id);
    assert.equal(relayChoice.label, 'grok-4.5');
    assert.deepEqual(decodeAgentModelChoice(relayChoice.value), {
        providerId: relay.id,
        modelId: relay.id
    });
    assert.equal(selectedAgentModelChoice(xaiGroups, xaiRuntime), '');
});

test('non-current services are never selectable from the Agent composer', () => {
    const groups = agentModelChoiceGroups([
        subscription,
        xai,
        { ...relay, credentialConfigured: false }
    ], snapshot('xai-api-key', [{ id: XAI_MANAGED_MODEL_ID, name: 'xAI / Grok API' }]));

    assert.deepEqual(groups, []);
    assert.equal(groups.some(group => group.providerId === relay.id), false);
});

test('subscription choices exclude catalog aliases whose credentials belong to another Provider', () => {
    const groups = agentModelChoiceGroups([subscription, xai, relay], snapshot('grok-subscription', [
        { id: 'grok-4.5', name: 'Grok 4.5' },
        { id: XAI_MANAGED_MODEL_ID, name: 'xAI / Grok API' },
        { id: relay.id, name: relay.name }
    ], 'grok-4.5'));
    const subscriptionGroup = groups.find(group => group.providerId === subscription.id);

    assert.deepEqual(subscriptionGroup.choices.map(choice => choice.modelId), ['grok-4.5']);
    assert.equal(groups.length, 1);
});

test('subscription choices hide the removed built-in xAI alias even when UI metadata no longer includes it', () => {
    const groups = agentModelChoiceGroups([
        { id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription', managed: true }
    ], snapshot('grok-subscription', [
        { id: XAI_MANAGED_MODEL_ID, name: '旧版 xAI API' },
        { id: 'grok-4.5', name: 'Grok 4.5' }
    ]));

    assert.deepEqual(groups[0].choices.map(choice => choice.modelId), ['grok-4.5']);
});

test('a stale selectedModel cannot reinsert the retired xAI alias', () => {
    const groups = agentModelChoiceGroups([subscription], snapshot('grok-subscription', [
        { id: XAI_MANAGED_MODEL_ID, name: 'xAI / Grok API' },
        { id: 'grok-4.5', name: 'Grok 4.5' }
    ], XAI_MANAGED_MODEL_ID));

    assert.deepEqual(groups[0].choices.map(choice => choice.modelId), ['grok-4.5']);
    assert.doesNotMatch(JSON.stringify(groups), /xAI|xora-xai-api/i);
});

test('ACP models remain hidden until Electron returns Provider ownership metadata', () => {
    const groups = agentModelChoiceGroups([], snapshot('grok-subscription', [
        { id: XAI_MANAGED_MODEL_ID, name: 'xAI / Grok API' },
        { id: 'grok-4.5', name: 'Grok 4.5' }
    ], 'grok-4.5'));

    assert.deepEqual(groups, []);
});

test('an API profile does not expose a route that switches Provider credentials in the composer', () => {
    const groups = agentModelChoiceGroups([subscription, xai, relay], snapshot('xora-relay', [
        { id: relay.id, name: relay.name }
    ], relay.id));

    assert.deepEqual(groups.map(group => group.providerId), [relay.id]);
    assert.equal(groups[0].choices[0].modelId, relay.id);
});

test('pending new-session selection is reflected immediately and can be rolled back explicitly', () => {
    const runtime = snapshot('grok-subscription', [
        { id: 'grok-fast', name: 'Grok Fast' },
        { id: 'grok-deep', name: 'Grok Deep' }
    ], 'grok-fast');
    const groups = agentModelChoiceGroups([subscription], runtime);

    assert.equal(
        decodeAgentModelChoice(selectedAgentModelChoice(groups, runtime, undefined, 'grok-deep')).modelId,
        'grok-deep'
    );
    assert.equal(
        decodeAgentModelChoice(selectedAgentModelChoice(groups, runtime, undefined, 'grok-fast')).modelId,
        'grok-fast'
    );
});
