import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import {
    type BundleManifest,
    buildFileEntries,
    keyIdOf,
    MANIFEST_FILE,
    signManifest,
    type TrustedKeys,
    type UnsignedManifest,
} from '../src/index.ts';

const temporaryDirs: string[] = [];

afterEach(async () => {
    for (const dir of temporaryDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

export async function temporaryDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'xora-updater-test-'));
    temporaryDirs.push(dir);
    return dir;
}

export interface TestKey {
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
    readonly keyId: string;
    readonly trusted: TrustedKeys;
}

export function testKey(): TestKey {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = keyIdOf(publicKeyPem);
    return { privateKeyPem, publicKeyPem, keyId, trusted: { [keyId]: publicKeyPem } };
}

export interface BundleOptions {
    readonly version?: string;
    readonly shell?: string;
    readonly files?: Readonly<Record<string, string>>;
}

/** Writes a small bundle with a signed manifest and returns its directory and manifest. */
export async function writeBundle(
    root: string,
    key: TestKey,
    options: BundleOptions = {},
): Promise<{ dir: string; manifest: BundleManifest }> {
    const version = options.version ?? '1.0.0';
    const dir = path.join(root, `bundle-${version}`);
    const files = options.files ?? {
        'host/index.cjs': 'process.parentPort.postMessage({ type: "xora:host-ready" });\n',
        'ui/index.html': '<!doctype html><title>ok</title>\n',
        'ui/assets/app.js': 'console.log("ok");\n',
    };
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }
    const unsigned: UnsignedManifest = {
        schemaVersion: 1,
        version,
        channel: 'dev',
        createdAt: '2026-10-30T00:00:00.000Z',
        requires: { shell: options.shell ?? '>=1.0.0-alpha.0 <2.0.0' },
        entry: { host: 'host/index.cjs', ui: 'ui/index.html' },
        files: await buildFileEntries(dir),
    };
    const manifest = signManifest(unsigned, key.privateKeyPem);
    await writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, manifest };
}
