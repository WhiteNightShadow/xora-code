import type { ModelSummary } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import { effortsOf, startingEffort } from '../src/thinking.ts';

type Reasoning = ModelSummary['reasoning'];
const toggle: Reasoning = { mode: 'toggle', efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
const always: Reasoning = { mode: 'always', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
const none: Reasoning = { mode: 'none', efforts: [], defaultEffort: 'off' };

describe('the thinking level of a new conversation', () => {
    it('offers what the model has, and "off" only when its thinking can be switched off', () => {
        expect(effortsOf(toggle)).toEqual(['off', 'low', 'high', 'max']);
        expect(effortsOf(always)).toEqual(['low', 'medium', 'high']);
        expect(effortsOf(none)).toEqual([]);
        expect(effortsOf(undefined)).toEqual([]);
    });

    it("starts from what was picked, else the user's default, else the model's, within what it offers", () => {
        expect(startingEffort(toggle, 'max', '')).toBe('max');
        expect(startingEffort(toggle, 'max', 'low')).toBe('low');
        // The user's default is a level this model lacks: the model's own.
        expect(startingEffort(always, 'max', '')).toBe('medium');
        // A pick the model lacks falls back the same way.
        expect(startingEffort(always, 'max', 'off')).toBe('medium');
        expect(startingEffort(none, 'high', 'high')).toBeUndefined();
        expect(startingEffort(undefined, 'high', '')).toBeUndefined();
    });
});
