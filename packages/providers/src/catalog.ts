import { ProviderError } from './errors.ts';
import { PRESETS } from './presets.ts';
import type { ModelInfo, ProviderConnection, ProviderPreset, Quirks, Wire } from './types.ts';

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

export function listPresets(): readonly ProviderPreset[] {
    return PRESETS;
}

export function getPreset(id: string): ProviderPreset | undefined {
    return BY_ID.get(id);
}

/** Conservative facts for a model id the catalog does not know, e.g. one discovered through `/models`. */
export function genericModel(id: string): ModelInfo {
    return {
        id,
        name: id,
        family: 'unknown',
        contextWindow: 128_000,
        maxOutput: 8_192,
        input: ['text'],
        reasoning: { mode: 'none', efforts: [], defaultEffort: 'off' },
        tools: true,
    };
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

/** The wire and base URL a connection talks to: the user's override, else the preset endpoint for that wire. */
export function endpointFor(connection: ProviderConnection): Endpoint {
    const { preset } = connection;
    const wire = connection.wire ?? preset.defaultWire;
    const baseUrl = connection.baseUrl?.trim() || preset.endpoints[wire];
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
    const { baseUrl } = endpoint;
    if (endpoint.wire === 'anthropic_messages') {
        const root = baseUrl.replace(/\/v1(\/messages)?$/, '');
        return `${root}/v1/${operation === 'generate' ? 'messages' : 'models'}`;
    }
    const root = baseUrl.replace(/\/chat\/completions$/, '');
    return `${root}/${operation === 'generate' ? 'chat/completions' : 'models'}`;
}
