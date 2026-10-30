import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
    type BundleManifest,
    buildFileEntries,
    MANIFEST_FILE,
    signManifest,
    type UnsignedManifest,
} from '../packages/updater/src/index.ts';
import { repoRoot, signingKey } from './keys.ts';

/**
 * Assembles an app bundle from the built UI and host, then writes a signed manifest:
 *
 *   <out>/ui/...            apps/ui/dist
 *   <out>/host/index.cjs    packages/host/dist/index.cjs
 *   <out>/manifest.json     files, hashes, shell range, ed25519 signature
 */

export interface BundleOptions {
    readonly out: string;
    readonly version?: string;
    readonly channel?: BundleManifest['channel'];
    readonly shell?: string;
    /** Drill only: replace the host with one that exits immediately. */
    readonly breakHost?: boolean;
}

async function readVersion(packageJson: string): Promise<string> {
    return (JSON.parse(await readFile(packageJson, 'utf8')) as { version: string }).version;
}

async function requireFile(file: string, hint: string): Promise<void> {
    try {
        await stat(file);
    } catch {
        throw new Error(`${path.relative(repoRoot, file)} is missing; ${hint}`);
    }
}

export async function makeBundle(options: BundleOptions): Promise<{ dir: string; manifest: BundleManifest }> {
    const uiDist = path.join(repoRoot, 'apps', 'ui', 'dist');
    const hostEntry = path.join(repoRoot, 'packages', 'host', 'dist', 'index.cjs');
    await requireFile(path.join(uiDist, 'index.html'), 'run `pnpm build` first');
    await requireFile(hostEntry, 'run `pnpm build` first');

    const version = options.version ?? (await readVersion(path.join(repoRoot, 'package.json')));
    const shellVersion = await readVersion(path.join(repoRoot, 'apps', 'desktop', 'package.json'));
    const shellMajor = Number.parseInt(shellVersion.split('.')[0] ?? '1', 10);
    const out = path.resolve(options.out);

    await rm(out, { recursive: true, force: true });
    await mkdir(path.join(out, 'host'), { recursive: true });
    await cp(uiDist, path.join(out, 'ui'), { recursive: true });
    if (options.breakHost) {
        await writeFile(path.join(out, 'host', 'index.cjs'), 'process.exit(3);\n', 'utf8');
    } else {
        await cp(hostEntry, path.join(out, 'host', 'index.cjs'));
    }

    const unsigned: UnsignedManifest = {
        schemaVersion: 1,
        version,
        channel: options.channel ?? 'dev',
        createdAt: new Date().toISOString(),
        requires: { shell: options.shell ?? `>=${shellVersion} <${shellMajor + 1}.0.0` },
        entry: { host: 'host/index.cjs', ui: 'ui/index.html' },
        files: await buildFileEntries(out),
    };
    const key = await signingKey();
    const manifest = signManifest(unsigned, key.privateKeyPem);
    await writeFile(path.join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { dir: out, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({
        options: {
            out: { type: 'string', default: path.join(repoRoot, 'dist', 'app-bundle') },
            version: { type: 'string' },
            channel: { type: 'string' },
            shell: { type: 'string' },
            'break-host': { type: 'boolean', default: false },
        },
    });
    const { dir, manifest } = await makeBundle({
        out: values.out,
        ...(values.version ? { version: values.version } : {}),
        ...(values.channel ? { channel: values.channel as BundleManifest['channel'] } : {}),
        ...(values.shell ? { shell: values.shell } : {}),
        breakHost: values['break-host'],
    });
    console.log(
        `bundle ${manifest.version} (${manifest.files.length} files, key ${manifest.signature?.keyId}) → ${path.relative(repoRoot, dir)}`,
    );
}
