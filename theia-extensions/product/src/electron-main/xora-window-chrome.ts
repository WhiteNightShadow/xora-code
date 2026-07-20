// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import type { TheiaBrowserWindowOptions } from '@theia/core/lib/electron-main/theia-electron-window';

export type XoraDesktopPlatform = 'darwin' | 'win32' | 'linux' | string;

/**
 * Keep the primary workbench visually frameless without sacrificing native
 * window controls. This is applied after Theia restores its persisted window
 * state so an older `frame` value cannot bring the legacy title bar back.
 */
export function applyXoraWindowChrome(
    options: TheiaBrowserWindowOptions,
    platform: XoraDesktopPlatform
): TheiaBrowserWindowOptions {
    const shared: TheiaBrowserWindowOptions = {
        ...options,
        hasShadow: true,
        roundedCorners: true,
        transparent: false,
        titleBarOverlay: false
    };

    if (platform === 'darwin') {
        return {
            ...shared,
            frame: true,
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 12 }
        };
    }

    return {
        ...shared,
        frame: false,
        titleBarStyle: 'hidden',
        // Preserve native resizing, shadows, animation and Windows Snap while
        // Theia renders the minimize/maximize/close controls inside the shell.
        thickFrame: true
    };
}

export function xoraTitleBarStyle(platform: XoraDesktopPlatform): 'native' | 'custom' {
    return platform === 'darwin' ? 'native' : 'custom';
}
