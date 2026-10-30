/**
 * Deterministic JSON: object keys are sorted and `undefined` members are dropped. Manifests are signed over
 * this form, so the build script and the bootstrap must both use this function.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value !== null && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            const member = source[key];
            if (member !== undefined) {
                sorted[key] = sortKeys(member);
            }
        }
        return sorted;
    }
    return value;
}
