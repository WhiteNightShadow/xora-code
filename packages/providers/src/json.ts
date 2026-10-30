/** Narrowing helpers for vendor JSON, which is never trusted to match its documentation. */

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Parses JSON text, returning `undefined` instead of throwing. */
export function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
