import { ProviderError } from './errors.ts';
import { GLM_ERROR_CODES, KIMI_ERROR_CODES, MINIMAX_ERROR_CODES, PRESETS } from './presets.ts';
import type { InputModality, ModelInfo, ProviderConnection, ProviderPreset, Quirks, Wire } from './types.ts';

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

export function listPresets(): readonly ProviderPreset[] {
    return PRESETS;
}

export function getPreset(id: string): ProviderPreset | undefined {
    return BY_ID.get(id);
}

/** Default context window assumed when a `/models` endpoint omits token limits (most current models support 1M). */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 1_000_000;

function inferVision(id: string): readonly InputModality[] {
    const lower = id.toLowerCase();
    if (/(^|[./:_-])claude-(2|instant)/.test(lower) || /^(minimax-m[12]|abab)/.test(lower)) {
        return ['text'];
    }
    if (
        /(^|[-_.:])(vl\d*|vlm|vision|omni|ocr)([-_.:]|$)|vision/.test(lower) ||
        /(^|[./:_-])claude/.test(lower) ||
        /^gemini|^gemma-?3/.test(lower) ||
        /^(chatgpt-4o|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-[5-9]|o[34])/.test(lower)
    ) {
        return ['text', 'image'];
    }
    return ['text'];
}

/**
 * Infers vendor family, window, vision and protocol quirks from a model ID when used via a custom / relay connection
 * (e.g. `MiniMax-M3`, `MiniMax-M2.7`, `claude-sonnet-4-5`, `deepseek-chat`, `glm-5`), while keeping unknown IDs
 * conservative.
 */
export function inferModelInfo(id: string, contextWindow?: number, maxOutput?: number): ModelInfo {
    const lower = id.toLowerCase();
    const input = inferVision(id);
    if (/^(minimax|abab)/i.test(id)) {
        const isM3 = /^minimax-m3/i.test(id);
        const hasEffort = /^minimax-m3\.\d/i.test(id);
        return {
            id,
            name: id,
            family: 'minimax',
            contextWindow: contextWindow ?? (isM3 ? 1_000_000 : 204_800),
            maxOutput: maxOutput ?? (isM3 ? 131_072 : 65_536),
            input,
            reasoning: hasEffort
                ? { mode: 'always', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' }
                : { mode: 'toggle', efforts: ['high'], defaultEffort: 'high' },
            tools: true,
            quirks: {
                reasoningField: 'reasoning_content',
                reasoningEcho: 'with_tools',
                extraBody: { reasoning_split: true },
                thinking: { kind: 'minimax', effort: hasEffort },
                omitParams: ['temperature', 'top_p'],
                errorCodes: MINIMAX_ERROR_CODES,
            },
        };
    }
    if (/(^|[./:_-])claude/i.test(lower)) {
        return {
            id,
            name: id,
            family: 'claude',
            contextWindow: contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
            maxOutput: maxOutput ?? 64_000,
            input,
            reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
            tools: true,
        };
    }
    if (/^deepseek/i.test(lower)) {
        const reasoner = /reasoner|r1|-pro/i.test(lower);
        return {
            id,
            name: id,
            family: 'deepseek',
            contextWindow: contextWindow ?? 1_048_576,
            maxOutput: maxOutput ?? 65_536,
            input,
            reasoning: reasoner
                ? { mode: 'always', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }
                : { mode: 'none', efforts: [], defaultEffort: 'off' },
            tools: true,
            quirks: {
                reasoningField: 'reasoning_content',
                ...(reasoner
                    ? {
                          reasoningEcho: 'with_tools',
                          omitParams: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
                      }
                    : {}),
            },
        };
    }
    if (/^glm-/i.test(lower)) {
        return {
            id,
            name: id,
            family: 'glm',
            contextWindow: contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
            maxOutput: maxOutput ?? 65_536,
            input,
            reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
            tools: true,
            quirks: { reasoningField: 'reasoning_content', errorCodes: GLM_ERROR_CODES },
        };
    }
    if (/^(kimi|moonshot)/i.test(lower)) {
        return {
            id,
            name: id,
            family: 'kimi',
            contextWindow: contextWindow ?? 1_048_576,
            maxOutput: maxOutput ?? 65_536,
            input,
            reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
            tools: true,
            quirks: { reasoningField: 'reasoning_content', errorCodes: KIMI_ERROR_CODES },
        };
    }
    if (input.includes('image')) {
        return {
            id,
            name: id,
            family: lower.startsWith('gemini') ? 'gemini' : lower.startsWith('qwen') ? 'qwen' : 'openai',
            contextWindow: contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
            maxOutput: maxOutput ?? 32_768,
            input,
            reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
            tools: true,
        };
    }
    return {
        id,
        name: id,
        family: 'unknown',
        contextWindow: contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
        maxOutput: maxOutput ?? 8_192,
        input: ['text'],
        reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
        tools: true,
    };
}

/** Default facts for a model id the catalog does not know, e.g. one discovered through `/models`. */
export function genericModel(id: string): ModelInfo {
    return inferModelInfo(id);
}

/** Looks a model up among the user's extra models, then the preset's; unknown ids get {@link genericModel}. */
export function findModel(connection: ProviderConnection, modelId: string): ModelInfo {
    return (
        connection.extraModels?.find((model) => model.id === modelId) ??
        connection.preset.models.find((model) => model.id === modelId) ??
        genericModel(modelId)
    );
}

/** Model quirks override preset quirks field by field; map-valued fields are merged key by key. */
export function resolveQuirks(preset: ProviderPreset, model?: ModelInfo): Quirks {
    const base = preset.quirks;
    const override = model?.quirks;
    if (override === undefined) {
        return base;
    }
    return {
        ...base,
        ...override,
        ...(base.effortMap && override.effortMap ? { effortMap: { ...base.effortMap, ...override.effortMap } } : {}),
        ...(base.errorCodes && override.errorCodes
            ? { errorCodes: { ...base.errorCodes, ...override.errorCodes } }
            : {}),
        ...(base.extraBody && override.extraBody ? { extraBody: { ...base.extraBody, ...override.extraBody } } : {}),
        ...(base.extraHeaders && override.extraHeaders
            ? { extraHeaders: { ...base.extraHeaders, ...override.extraHeaders } }
            : {}),
    };
}

export interface Endpoint {
    readonly wire: Wire;
    /** Base URL without a trailing slash. */
    readonly baseUrl: string;
}

/**
 * Cleans user-entered Base URLs (`firefox-reverse` style): strips invisible clipboard characters, query/hash,
 * and accidental operation suffixes (`/chat/completions`, `/messages`, `/models`).
 */
export function normalizeBaseUrl(raw: string): string {
    let cleaned = raw
        .replace(/[\r\n\uFEFF\u200B-\u200D]/g, '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');
    cleaned = cleaned.replace(/\/(chat\/completions|completions|messages|responses|models)$/i, '');
    return cleaned.replace(/\/+$/, '');
}

export function hasVersionSegment(baseUrl: string): boolean {
    const pathPart = baseUrl.replace(/^https?:\/\/[^/]*/i, '');
    return /\/v\d+[a-z]*(?:\.\d+)?(?:\/|$)/i.test(pathPart);
}

/** The wire and base URL a connection talks to: the user's override, else the preset endpoint for that wire. */
export function endpointFor(connection: ProviderConnection): Endpoint {
    const { preset } = connection;
    const userUrl = connection.baseUrl ? normalizeBaseUrl(connection.baseUrl) : '';
    const wire =
        connection.wire ??
        (userUrl && /\/anthropic(?:\/v1)?$/i.test(userUrl) ? 'anthropic_messages' : preset.defaultWire);
    const baseUrl = userUrl || preset.endpoints[wire];
    if (!baseUrl) {
        throw new ProviderError(`${preset.name} has no ${wire} endpoint; set a base URL`, {
            errorClass: 'invalid_request',
            provider: preset.id,
        });
    }
    return { wire, baseUrl: baseUrl.replace(/\/+$/, '') };
}

/** Full URL of an operation, tolerating base URLs that already end in `/v1` or in the operation itself. */
export function operationUrl(endpoint: Endpoint, operation: 'generate' | 'models'): string {
    const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
    if (endpoint.wire === 'anthropic_messages') {
        const root = baseUrl.replace(/\/v1$/i, '');
        return `${root}/v1/${operation === 'generate' ? 'messages' : 'models'}`;
    }
    return `${baseUrl}/${operation === 'generate' ? 'chat/completions' : 'models'}`;
}

/**
 * Alternate URL with or without `/v1` when a custom or relay OpenAI-compatible base URL was entered without `/v1`
 * (e.g. `https://api.minimaxi.com` → `https://api.minimaxi.com/v1/chat/completions`) or vice versa.
 */
export function alternateOperationUrl(endpoint: Endpoint, operation: 'generate' | 'models'): string | undefined {
    const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
    if (endpoint.wire === 'anthropic_messages') {
        return operation === 'models' ? `${baseUrl.replace(/\/v1$/i, '')}/models` : undefined;
    }
    const suffix = operation === 'generate' ? 'chat/completions' : 'models';
    if (hasVersionSegment(baseUrl)) {
        const stripped = baseUrl.replace(/\/v1$/i, '');
        return stripped !== baseUrl ? `${stripped}/${suffix}` : undefined;
    }
    return `${baseUrl}/v1/${suffix}`;
}
