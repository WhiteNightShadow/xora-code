// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

/**
 * Path helpers shared by the renderer (URI → fs path) and Electron main
 * (defense-in-depth repair of Windows URI-path forms before realpath/trust).
 *
 * Important: never read `process` as a bare default in browser code. The
 * renderer does not define Node's `process` global; callers should pass an
 * explicit platform, and helpers fall back safely when `process` is missing.
 */

function resolvePlatform(platform?: NodeJS.Platform): NodeJS.Platform {
    if (platform) return platform;
    if (typeof process !== 'undefined' && process.platform) {
        return process.platform;
    }
    return 'linux';
}

/**
 * Repair Windows path forms that commonly leak from URI.path:
 * - `/d:/foo` or `\d:\foo` → `d:\foo`
 * - `D:\d:\foo` (doubled drive) → `D:\foo`
 * - `file:///d%3A/foo` is not handled here; use FileUri.fsPath in the browser.
 */
export function normalizeWindowsFilesystemPath(input: string, platform?: NodeJS.Platform): string {
    const resolved = resolvePlatform(platform);
    if (!input || resolved !== 'win32') {
        return input;
    }

    let value = input.replace(/\//g, '\\');

    // URI.path form: \d:\project or /d:/project already converted to backslash.
    const posixDrive = value.match(/^\\([A-Za-z]):(\\.+)$/);
    if (posixDrive) {
        value = `${posixDrive[1]}:${posixDrive[2]}`;
    }

    // Doubled drive after a bad resolve: D:\d:\project
    const doubled = value.match(/^([A-Za-z]):\\([A-Za-z]):\\(.*)$/);
    if (doubled && doubled[1].toLowerCase() === doubled[2].toLowerCase()) {
        value = `${doubled[1]}:\\${doubled[3]}`;
    }

    return value;
}

/** Stable form for context keys and membership checks (not for display). */
export function filesystemPathKey(input: string, platform?: NodeJS.Platform): string {
    if (!input) return '';
    const resolved = resolvePlatform(platform);
    let value = normalizeWindowsFilesystemPath(input, resolved).replace(/\\/g, '/');
    if (value.length > 1 && value.endsWith('/')) {
        value = value.slice(0, -1);
    }
    if (resolved === 'win32') {
        value = value.toLowerCase();
    }
    return value;
}

export function filesystemPathsEqual(
    left: string | undefined,
    right: string | undefined,
    platform?: NodeJS.Platform
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return filesystemPathKey(left, platform) === filesystemPathKey(right, platform);
}

export function filesystemPathListIncludes(
    list: readonly string[],
    candidate: string | undefined,
    platform?: NodeJS.Platform
): boolean {
    if (!candidate) return false;
    const key = filesystemPathKey(candidate, platform);
    return list.some(entry => filesystemPathKey(entry, platform) === key);
}
