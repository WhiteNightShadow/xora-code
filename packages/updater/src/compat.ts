import semver from 'semver';

/** Whether a shell (the installed Electron app) satisfies an app bundle's `requires.shell` range. */
export function isShellCompatible(shellVersion: string, range: string): boolean {
    if (!semver.valid(shellVersion) || !semver.validRange(range)) {
        return false;
    }
    return semver.satisfies(shellVersion, range, { includePrerelease: true });
}
