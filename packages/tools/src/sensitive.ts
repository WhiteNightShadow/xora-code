import os from 'node:os';

/**
 * Files that hold credentials. The host asks before a tool touches one, even in modes that would otherwise allow the
 * call (see docs/design/10-security.md §4).
 *
 * Matched by file name anywhere:
 * - `.env` and `.env*` variants such as `.env.local` or `.envrc`, except the templates `.env.example`, `.env.sample`
 *   and `.env.template`;
 * - keys and certificates: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.ppk`, `*.jks`, `*.keystore`;
 * - SSH keys: `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`;
 * - credential stores: `.npmrc`, `.netrc`, `_netrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `credentials.json`;
 * - keychains and their exports: `*.keychain`, `*.keychain-db`.
 *
 * Matched by location:
 * - anything inside a `.ssh`, `.aws` or `.gnupg` directory;
 * - in the home directory: `.docker/config.json`, `.kube/config` and `Library/Keychains/**`.
 *
 * Comparison ignores case and treats `\` like `/`, which errs towards asking. Check the resolved real path as well as
 * the requested one, since a harmless-looking symlink can point at a key.
 */
export function isSensitivePath(p: string, home: string = os.homedir()): boolean {
    const target = normalise(p);
    const parts = target.split('/').filter((part) => part !== '');
    const last = parts.at(-1);
    if (last === undefined) {
        return false;
    }
    // Windows ignores trailing dots and spaces and reads `name:stream` as a stream of `name`.
    const name = last.replace(/[. ]+$/, '').split(':')[0] ?? last;
    if (isSensitiveName(name)) {
        return true;
    }
    if (parts.slice(0, -1).some((part) => SECRET_DIRS.has(part))) {
        return true;
    }
    const homeDir = normalise(home);
    if (homeDir !== '' && target.startsWith(`${homeDir}/`)) {
        const relative = target.slice(homeDir.length + 1);
        return HOME_FILES.has(relative) || relative.startsWith('library/keychains/');
    }
    return false;
}

const SECRET_DIRS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg']);
const HOME_FILES: ReadonlySet<string> = new Set(['.docker/config.json', '.kube/config']);
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
    '.npmrc',
    '.netrc',
    '_netrc',
    '.pypirc',
    '.git-credentials',
    '.pgpass',
    'credentials.json',
]);
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample', '.env.template']);
const SECRET_EXTENSIONS = [
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.p8',
    '.ppk',
    '.jks',
    '.keystore',
    '.keychain',
    '.keychain-db',
];
const SSH_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

function isSensitiveName(name: string): boolean {
    if (name.startsWith('.env')) {
        return !ENV_TEMPLATES.has(name);
    }
    return (
        SECRET_FILE_NAMES.has(name) ||
        SECRET_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
        SSH_KEY_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
}

function normalise(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
