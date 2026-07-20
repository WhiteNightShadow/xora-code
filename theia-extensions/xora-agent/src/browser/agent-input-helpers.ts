export interface PromptEnterState {
    key: string;
    shiftKey: boolean;
    widgetComposing: boolean;
    nativeComposing: boolean;
    nativeKeyCode?: number;
    compositionJustEnded: boolean;
}
/**
 * Browser IME implementations do not agree on `KeyboardEvent.isComposing` at
 * the exact Enter event that commits a candidate. Keep the widget-level
 * composition state, the legacy keyCode 229 signal, and a one-task guard after
 * compositionend so committing Chinese text can never submit the prompt.
 */
export function shouldSubmitPromptOnEnter(state: PromptEnterState): boolean {
    return state.key === 'Enter'
        && !state.shiftKey
        && !state.widgetComposing
        && !state.nativeComposing
        && state.nativeKeyCode !== 229
        && !state.compositionJustEnded;
}
