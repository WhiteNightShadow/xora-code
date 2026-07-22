// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for editing Grok config.toml managed provider blocks.
 * Kept free of Electron/fs so unit tests can exercise redefine recovery.
 */

export const MANAGED_BLOCK_START = '# >>> Xora Code managed providers >>>';
export const MANAGED_BLOCK_END = '# <<< Xora Code managed providers <<<';
export const LEGACY_MANAGED_BLOCK_START = '# >>> WhiteNight Code managed providers >>>';
export const LEGACY_MANAGED_BLOCK_END = '# <<< WhiteNight Code managed providers <<<';

export function removeMarkedManagedBlocksFromToml(source: string): string {
    let result = source;
    for (const [startMarker, endMarker] of [
        [MANAGED_BLOCK_START, MANAGED_BLOCK_END],
        [LEGACY_MANAGED_BLOCK_START, LEGACY_MANAGED_BLOCK_END]
    ] as const) {
        while (true) {
            const start = result.indexOf(startMarker);
            const end = result.indexOf(endMarker);
            if (start < 0 || end < 0 || end < start) {
                break;
            }
            let removeEnd = end + endMarker.length;
            if (result[removeEnd] === '\r') removeEnd += 1;
            if (result[removeEnd] === '\n') removeEnd += 1;
            let removeStart = start;
            if (removeStart >= 2 && result.slice(removeStart - 2, removeStart) === '\n\n') {
                removeStart -= 1;
            }
            result = `${result.slice(0, removeStart)}${result.slice(removeEnd)}`;
        }
    }
    return result;
}

export function removeModelTablesFromToml(source: string, catalogIds: readonly string[]): string {
    let result = source;
    for (const catalogId of catalogIds) {
        result = removeModelTableFromToml(result, catalogId);
    }
    return result;
}

/**
 * Removes every TOML table matching [model.<id>] / [model."id"] / [model.'id']
 * and its body until the next table header. Bare and quoted keys are equivalent
 * in TOML and both must be removed to avoid "redefine table" errors.
 */
export function removeModelTableFromToml(source: string, catalogId: string): string {
    if (!catalogId) return source;
    const escaped = catalogId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const header = new RegExp(
        `^\\s*\\[model\\.(?:"${escaped}"|'${escaped}'|${escaped})\\]\\s*(?:#.*)?$`,
        'm'
    );
    let result = source;
    for (let guard = 0; guard < 32; guard += 1) {
        const match = header.exec(result);
        if (!match || match.index === undefined) break;
        const start = match.index;
        let bodyStart = start + match[0].length;
        if (result[bodyStart] === '\r') bodyStart += 1;
        if (result[bodyStart] === '\n') bodyStart += 1;
        const rest = result.slice(bodyStart);
        const next = /^\s*\[[^\]]+\]\s*(?:#.*)?$/m.exec(rest);
        const end = next?.index === undefined ? result.length : bodyStart + next.index;
        result = `${result.slice(0, start)}${result.slice(end)}`;
    }
    return result;
}
