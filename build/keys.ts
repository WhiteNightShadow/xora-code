import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyIdOf } from '../packages/updater/src/manifest.ts';

/**
 * App bundle signing keys. Development builds generate a local key in `.keys/` (git-ignored); release builds
 * sign with `XORA_SIGNING_KEY_FILE` and trust only the committed public keys in `build/keys/trusted/*.pub`.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devKeyFile = path.join(repoRoot, '.keys', 'dev-signing.pem');
const trustedDir = path.join(repoRoot, 'build', 'keys', 'trusted');

export interface SigningKey {
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
    readonly keyId: string;
    readonly source: 'dev' | 'release';
}

function fromPrivatePem(privateKeyPem: string, source: SigningKey['source']): SigningKey {
    const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
        .export({ type: 'spki', format: 'pem' })
        .toString();
    return { privateKeyPem, publicKeyPem, keyId: keyIdOf(publicKeyPem), source };
}

export async function ensureDevKey(): Promise<SigningKey> {
    try {
        return fromPrivatePem(await readFile(devKeyFile, 'utf8'), 'dev');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await mkdir(path.dirname(devKeyFile), { recursive: true, mode: 0o700 });
    await writeFile(devKeyFile, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
    const key = fromPrivatePem(privateKeyPem, 'dev');
    console.log(`generated local development signing key ${key.keyId} at ${devKeyFile}`);
    return key;
}

export async function signingKey(): Promise<SigningKey> {
    const file = process.env.XORA_SIGNING_KEY_FILE?.trim();
    return file ? fromPrivatePem(await readFile(file, 'utf8'), 'release') : ensureDevKey();
}

const isRelease = (): boolean => process.env.XORA_RELEASE === '1';

/** keyId → PEM for every key the built shell should accept. */
export async function loadTrustedKeys(): Promise<Record<string, string>> {
    const trusted: Record<string, string> = {};
    let entries: string[] = [];
    try {
        entries = await readdir(trustedDir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    for (const name of entries.filter((entry) => entry.endsWith('.pub')).sort()) {
        const pem = await readFile(path.join(trustedDir, name), 'utf8');
        trusted[keyIdOf(pem)] = pem;
    }
    if (!isRelease()) {
        const dev = await ensureDevKey();
        trusted[dev.keyId] = dev.publicKeyPem;
    }
    if (Object.keys(trusted).length === 0) {
        throw new Error('no trusted bundle keys: add build/keys/trusted/<keyId>.pub or build without XORA_RELEASE=1');
    }
    return trusted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const key = await ensureDevKey();
    console.log(`development signing key: ${key.keyId}`);
}
