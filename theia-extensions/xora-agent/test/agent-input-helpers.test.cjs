const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldSubmitPromptOnEnter } = require('../lib/browser/agent-input-helpers');

function state(overrides = {}) {
    return {
        key: 'Enter',
        shiftKey: false,
        widgetComposing: false,
        nativeComposing: false,
        nativeKeyCode: 13,
        compositionJustEnded: false,
        ...overrides
    };
}

test('plain Enter submits while Shift+Enter remains a newline', () => {
    assert.equal(shouldSubmitPromptOnEnter(state()), true);
    assert.equal(shouldSubmitPromptOnEnter(state({ shiftKey: true })), false);
    assert.equal(shouldSubmitPromptOnEnter(state({ key: 'a' })), false);
});
test('every browser IME signal prevents candidate Enter from submitting', () => {
    assert.equal(shouldSubmitPromptOnEnter(state({ widgetComposing: true })), false);
    assert.equal(shouldSubmitPromptOnEnter(state({ nativeComposing: true })), false);
    assert.equal(shouldSubmitPromptOnEnter(state({ nativeKeyCode: 229 })), false);
    assert.equal(shouldSubmitPromptOnEnter(state({ compositionJustEnded: true })), false);
});
