export interface PromptEnterState {
    key: string;
    shiftKey: boolean;
    widgetComposing: boolean;
    nativeComposing: boolean;
    nativeKeyCode?: number;
    compositionJustEnded: boolean;
}

export interface RenameEnterState {
    key: string;
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

/**
 * A single-line rename input uses Enter as its explicit commit action. Keep it
 * separate from prompt submission so Shift does not become part of the API,
 * while applying the same cross-browser IME safeguards.
 */
export function shouldCommitRenameOnEnter(state: RenameEnterState): boolean {
    return state.key === 'Enter'
        && !state.widgetComposing
        && !state.nativeComposing
        && state.nativeKeyCode !== 229
        && !state.compositionJustEnded;
}
