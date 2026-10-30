import { describe, expect, it } from 'vitest';
import {
    endpointFor,
    findModel,
    getPreset,
    listPresets,
    type ModelInfo,
    nearestEffort,
    operationUrl,
    planThinking,
    planToolChoice,
    type ReasoningEffort,
    resolveQuirks,
} from '../src/index.ts';
import { preset } from './helpers.ts';

const LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('presets', () => {
    it('have unique ids and internally consistent data', () => {
        const presets = listPresets();
        expect(new Set(presets.map((entry) => entry.id)).size).toBe(presets.length);
        for (const entry of presets) {
            if (entry.channel !== 'custom') {
                expect([entry.id, entry.endpoints[entry.defaultWire]]).toEqual([entry.id, expect.any(String)]);
            }
            for (const url of Object.values(entry.endpoints)) {
                const local = entry.channel === 'local';
                expect([entry.id, url.startsWith(local ? 'http://127.0.0.1:' : 'https://')]).toEqual([entry.id, true]);
                expect(url.endsWith('/')).toBe(false);
            }
            if (entry.verified !== undefined) {
                expect(entry.verified).toMatch(DATE);
            }
            const modelIds = entry.models.map((model) => model.id);
            expect(new Set(modelIds).size).toBe(modelIds.length);
            for (const model of entry.models) {
                const label = `${entry.id}/${model.id}`;
                expect([label, model.contextWindow > model.maxOutput, model.maxOutput > 0]).toEqual([
                    label,
                    true,
                    true,
                ]);
                const ranks = model.reasoning.efforts.map((effort) => LEVELS.indexOf(effort));
                expect([label, ranks]).toEqual([label, [...ranks].sort((a, b) => a - b)]);
                if (model.reasoning.defaultEffort !== 'off') {
                    expect([label, model.reasoning.efforts]).toEqual([
                        label,
                        expect.arrayContaining([model.reasoning.defaultEffort]),
                    ]);
                } else {
                    expect([label, model.reasoning.mode]).not.toEqual([label, 'always']);
                }
                if (model.pricing !== undefined) {
                    expect(model.pricing).toMatch(/^[a-z0-9.-]+@\d{4}-\d{2}$/);
                }
                if (model.verified !== undefined) {
                    expect(model.verified).toMatch(DATE);
                }
            }
        }
    });

    it('carry the verified vendor facts', () => {
        expect(findModel({ preset: preset('deepseek') }, 'deepseek-flash')).toMatchObject({
            contextWindow: 1_048_576,
            maxOutput: 393_216,
            input: ['text', 'image'],
            reasoning: { mode: 'toggle', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
            pricing: 'deepseek-flash@2026-10',
        });
        expect(preset('deepseek').endpoints).toEqual({
            openai_chat: 'https://api.deepseek.com',
            anthropic_messages: 'https://api.deepseek.com/anthropic',
        });
        expect(preset('kimi-cn').endpoints.openai_chat).toBe('https://api.moonshot.cn/v1');
        expect(preset('kimi-global').endpoints.openai_chat).toBe('https://api.moonshot.ai/v1');
        expect(preset('kimi-code-cn').endpoints.openai_chat).toBe('https://api.kimi.com/coding/v1');
        expect(preset('kimi-code-global').endpoints.openai_chat).toBe('https://api.kimi.ai/coding/v1');
        expect(preset('kimi-code-cn')).toMatchObject({
            channel: 'subscription_key',
            compliance: { interactiveOnly: true },
            models: [{ id: 'k3.1-pro' }, { id: 'k3' }],
        });
        expect(preset('kimi-code-cn').models.every((model) => model.pricing === undefined)).toBe(true);
        expect(findModel({ preset: preset('kimi-cn') }, 'kimi-k3').pricing).toBe('kimi-k3@2026-10');
        expect(preset('glm-cn').endpoints).toEqual({
            openai_chat: 'https://open.bigmodel.cn/api/paas/v4',
            anthropic_messages: 'https://open.bigmodel.cn/api/anthropic',
        });
        expect(preset('glm-global').endpoints.openai_chat).toBe('https://api.z.ai/api/paas/v4');
        expect(preset('glm-coding-cn')).toMatchObject({
            endpoints: { openai_chat: 'https://open.bigmodel.cn/api/coding/paas/v4' },
            compliance: { allowed: false },
        });
        expect(preset('glm-coding-global').endpoints.openai_chat).toBe('https://api.z.ai/api/coding/paas/v4');
        expect(findModel({ preset: preset('glm-cn') }, 'glm-5.3')).toMatchObject({
            maxOutput: 131_072,
            reasoning: { mode: 'always' },
            pricing: 'glm-5.3@2026-10',
        });
        const claude = preset('anthropic');
        expect(claude).toMatchObject({
            auth: 'x-api-key',
            endpoints: { anthropic_messages: 'https://api.anthropic.com' },
        });
        expect(claude.models.map((model) => [model.id, model.contextWindow, model.maxOutput, model.pricing])).toEqual([
            ['claude-opus-5-5', 1_000_000, 128_000, 'claude-opus-5-5@2026-10'],
            ['claude-sonnet-5-5', 1_000_000, 128_000, 'claude-sonnet-5-5@2026-10'],
            ['claude-haiku-5-5', 1_000_000, 128_000, 'claude-haiku-5-5@2026-10'],
            ['claude-fable-5-1', 1_000_000, 128_000, 'claude-fable-5-1@2026-10'],
        ]);
    });

    it('leave unverified facts unmarked', () => {
        expect(findModel({ preset: preset('deepseek') }, 'deepseek-v4-pro').verified).toBeUndefined();
        for (const id of ['openai', 'gemini', 'xai', 'openrouter', 'mistral', 'qwen-cn', 'doubao', 'ollama', 'vllm']) {
            expect([id, preset(id).verified, preset(id).models]).toEqual([id, undefined, []]);
        }
        expect(getPreset('nope')).toBeUndefined();
    });
});

describe('catalog lookups', () => {
    const extra: ModelInfo = {
        id: 'deepseek-flash',
        name: 'Flash with a smaller window',
        family: 'deepseek',
        contextWindow: 64_000,
        maxOutput: 8_000,
        input: ['text'],
        reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
        tools: true,
    };

    it("prefers the user's models, then the preset, then a conservative generic model", () => {
        expect(findModel({ preset: preset('deepseek'), extraModels: [extra] }, 'deepseek-flash').contextWindow).toBe(
            64_000,
        );
        expect(findModel({ preset: preset('deepseek') }, 'something-new')).toEqual({
            id: 'something-new',
            name: 'something-new',
            family: 'unknown',
            contextWindow: 128_000,
            maxOutput: 8_192,
            input: ['text'],
            reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
            tools: true,
        });
    });

    it('lets model quirks override preset quirks and merges map-valued fields', () => {
        const kimi = preset('kimi-cn');
        const model: ModelInfo = { ...extra, quirks: { reasoningEcho: 'never', errorCodes: { '42': 'quota' } } };
        const quirks = resolveQuirks(kimi, model);
        expect(quirks.reasoningEcho).toBe('never');
        expect(quirks.maxTokensField).toBe('max_completion_tokens');
        expect(quirks.errorCodes).toMatchObject({ '42': 'quota', engine_overloaded_error: 'overloaded' });
        expect(resolveQuirks(kimi)).toBe(kimi.quirks);
        const haiku = findModel({ preset: preset('anthropic') }, 'claude-haiku-5-5');
        expect(resolveQuirks(preset('anthropic'), haiku)).toMatchObject({
            toolChoice: ['auto', 'none', 'required', 'function'],
            thinking: { kind: 'anthropic_adaptive', offMode: 'disabled' },
            omitParams: ['temperature', 'top_p', 'top_k'],
        });
    });

    it('resolves endpoints and operation URLs', () => {
        const deepseek = preset('deepseek');
        expect(endpointFor({ preset: deepseek })).toEqual({ wire: 'openai_chat', baseUrl: 'https://api.deepseek.com' });
        expect(endpointFor({ preset: deepseek, wire: 'anthropic_messages' })).toEqual({
            wire: 'anthropic_messages',
            baseUrl: 'https://api.deepseek.com/anthropic',
        });
        expect(endpointFor({ preset: deepseek, baseUrl: 'https://relay.example/v1//' }).baseUrl).toBe(
            'https://relay.example/v1',
        );
        const url = (wire: 'openai_chat' | 'anthropic_messages', baseUrl: string, operation: 'generate' | 'models') =>
            operationUrl({ wire, baseUrl }, operation);
        expect(url('openai_chat', 'https://api.deepseek.com', 'generate')).toBe(
            'https://api.deepseek.com/chat/completions',
        );
        expect(url('openai_chat', 'https://x/v1/chat/completions', 'models')).toBe('https://x/v1/models');
        expect(url('anthropic_messages', 'https://api.kimi.com/coding', 'generate')).toBe(
            'https://api.kimi.com/coding/v1/messages',
        );
        expect(url('anthropic_messages', 'https://relay/v1', 'generate')).toBe('https://relay/v1/messages');
        expect(url('anthropic_messages', 'https://api.anthropic.com', 'models')).toBe(
            'https://api.anthropic.com/v1/models',
        );
    });
});

describe('effort planning', () => {
    it('picks the nearest supported level, rounding ties up', () => {
        expect(nearestEffort('medium', ['low', 'high', 'max'])).toBe('high');
        expect(nearestEffort('medium', ['low', 'max'])).toBe('low');
        expect(nearestEffort('max', ['low', 'medium'])).toBe('medium');
        expect(nearestEffort('low', [])).toBeUndefined();
    });

    it('plans thinking per reasoning mode', () => {
        const flash = findModel({ preset: preset('deepseek') }, 'deepseek-flash');
        const glm = findModel({ preset: preset('glm-cn') }, 'glm-5.3');
        expect(planThinking(flash, {}, 'off')).toEqual({ on: false });
        expect(planThinking(flash, {}, undefined)).toEqual({ on: true, effort: 'high', vendorEffort: 'high' });
        expect(planThinking(glm, {}, 'off')).toEqual({ on: true, effort: 'low', vendorEffort: 'low' });
        expect(planThinking(glm, { effortMap: { low: 'minimal' } }, 'low')).toEqual({
            on: true,
            effort: 'low',
            vendorEffort: 'minimal',
        });
        expect(planThinking(findModel({ preset: preset('deepseek') }, 'unknown'), {}, 'max')).toEqual({ on: false });
    });

    it('downgrades tool_choice values the vendor rejects', () => {
        expect(planToolChoice('required', { toolChoice: ['auto'] }, false)).toEqual({ kind: 'auto' });
        expect(planToolChoice({ name: 'read' }, {}, false)).toEqual({ kind: 'function', name: 'read' });
        expect(planToolChoice('required', { toolChoiceWhenThinking: ['auto', 'none'] }, true)).toEqual({
            kind: 'auto',
        });
        expect(planToolChoice('required', { toolChoiceWhenThinking: ['auto', 'none'] }, false)).toEqual({
            kind: 'required',
        });
        expect(planToolChoice('none', { toolChoice: ['required'] }, false)).toBeUndefined();
        expect(planToolChoice(undefined, {}, false)).toBeUndefined();
    });
});
