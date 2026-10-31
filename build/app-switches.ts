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
