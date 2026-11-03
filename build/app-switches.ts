import { execFileSync } from 'node:child_process';

/**
 * Switches for every scripted run of the app: keep safeStorage and cookie encryption away from the machine's
 * keychain (macOS) or keyring (Linux), which can block the app on an access prompt. Windows encrypts with the
 * user's DPAPI key and never asks.
 */
export function secretStoreSwitches(platform: NodeJS.Platform = process.platform): string[] {
    switch (platform) {
        case 'darwin':
            return ['--use-mock-keychain'];
        case 'linux':
            return ['--password-store=basic'];
        default:
            return [];
    }
}

const LSREGISTER =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * macOS registers every app bundle it launches with LaunchServices under its bundle id, and may then show the app's
 * notifications with a copy's icon and name. A scripted run forgets its copy of the app before it goes.
 */
export function forgetAppCopy(appDir: string | undefined): void {
    if (process.platform !== 'darwin' || !appDir) return;
    try {
        execFileSync(LSREGISTER, ['-u', appDir], { stdio: 'ignore' });
    } catch {
        // Not registered, or no LaunchServices tool: nothing to forget.
    }
}
