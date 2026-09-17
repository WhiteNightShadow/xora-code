// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import URI from '@theia/core/lib/common/uri';

const RECOVERY_KEY = 'xora.workspace-recovery:';

export interface WorkspaceRecoveryStorage {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Normalize launcher/MRU spelling only, without accessing an unavailable drive. */
export function workspaceRecoveryKey(uri: string, windows: boolean): string {
    if (windows) {
        try {
            const parsed = new URI(uri);
            const value = parsed.path.toString();
            if (parsed.scheme === 'file' && (parsed.authority || /^\/[a-z]:[\\/]/i.test(value))) {
                // Windows also supports case-sensitive directories. Normalize
                // the drive letter and separators, never the remaining path.
                const normalized = value.replace(/\\/g, '/').replace(/^\/([A-Z]):/, (_, drive: string) => `/${drive.toLowerCase()}:`);
                uri = parsed.withPath(normalized).withAuthority(parsed.authority.toLowerCase()).toString();
            }
        } catch {
            // A malformed legacy marker keeps its original identity.
        }
    }
    return RECOVERY_KEY + uri;
}

function matchingKeys(storage: WorkspaceRecoveryStorage, uri: string, windows: boolean): string[] {
    const canonical = workspaceRecoveryKey(uri, windows);
    const keys = new Set([canonical, RECOVERY_KEY + uri]);
    if (windows) {
        // Older releases stored raw URIs. Preserve their quarantine across a
        // launcher spelling change, and clear every equivalent marker on retry.
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key?.startsWith(RECOVERY_KEY)
                && workspaceRecoveryKey(key.slice(RECOVERY_KEY.length), windows) === canonical) {
                keys.add(key);
            }
        }
    }
    return [...keys];
}

export function readWorkspaceRecoveryState(storage: WorkspaceRecoveryStorage, uri: string, windows: boolean): string | null {
    for (const key of matchingKeys(storage, uri, windows)) {
        const state = storage.getItem(key);
        if (state !== null) return state;
    }
    return null;
}

export function writeWorkspaceRecoveryState(
    storage: WorkspaceRecoveryStorage,
    uri: string,
    windows: boolean,
    state: 'pending' | 'failed' | undefined
): void {
    const keys = matchingKeys(storage, uri, windows);
    const canonical = workspaceRecoveryKey(uri, windows);
    // Preserve old markers if writing the canonical marker fails (for example,
    // because browser storage is full or temporarily unavailable).
    if (state) storage.setItem(canonical, state);
    for (const key of keys) {
        if (!state || key !== canonical) storage.removeItem(key);
    }
}
