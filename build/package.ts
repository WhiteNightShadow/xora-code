import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from './keys.ts';

/**
 * Release packaging (13 §2): every installer is made on this mac. node-pty ships N-API prebuilds for the six
 * targets, and electron-builder edits Windows resources and takes the NSIS uninstaller out of the installer in
 * JavaScript on a mac, so neither Windows, Linux nor Wine is needed. Installers land in apps/desktop/release
 * next to a SHA256SUMS file.
 *
 *   node build/package.ts                          all six targets
 *   node build/package.ts win-arm64 linux-x64      some of them
 *   node build/package.ts --skip-build ...         reuse the last `pnpm build && pnpm bundle`
 */

const TARGETS: Readonly<Record<string, readonly string[]>> = {
    'mac-arm64': ['--mac', 'dmg', 'zip', '--arm64'],
    'mac-x64': ['--mac', 'dmg', 'zip', '--x64'],
    'win-x64': ['--win', 'nsis', '--x64'],
    'win-arm64': ['--win', 'nsis', '--arm64'],
    'linux-x64': ['--linux', 'AppImage', 'deb', '--x64'],
    'linux-arm64': ['--linux', 'AppImage', 'deb', '--arm64'],
};
const INSTALLER = /\.(dmg|zip|exe|AppImage|deb)$/;

const { values, positionals } = parseArgs({
    options: { 'skip-build': { type: 'boolean', default: false } },
    allowPositionals: true,
});
const targets = positionals.length > 0 ? positionals : Object.keys(TARGETS);
const unknown = targets.filter((target) => !(target in TARGETS));
if (unknown.length > 0) {
    throw new Error(`unknown target ${unknown.join(', ')}; one of ${Object.keys(TARGETS).join(', ')}`);
}

const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const releaseDir = path.join(desktopDir, 'release');

function run(command: string, args: readonly string[], cwd: string): void {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
    }
}

/** The 7-Zip electron-builder downloads for itself; undefined before its first Windows build. */
function sevenZip(): string | undefined {
    const cache = path.join(homedir(), 'Library', 'Caches', 'electron-builder');
    for (const version of existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith('7zip@')) : []) {
        for (const build of readdirSync(path.join(cache, version))) {
            const binary = path.join(cache, version, build, 'bin', '7zz');
            if (existsSync(binary)) return binary;
        }
    }
    return undefined;
}

/**
 * The NSIS plugin that unpacks the app at install time cannot read the ARM64 branch filter that newer 7-Zip
 * picks for arm64 code: such an installer reports success and leaves out every .exe and .dll (pabox ran into
 * this with electron-builder 26.15). 26.18 pins these archives to BCJ; this check keeps it that way.
 */
async function checkWindowsArchive(installer: string): Promise<void> {
    const sevenZ = sevenZip();
    if (!sevenZ) {
        console.warn(`(no 7zz in the electron-builder cache: skipped the archive check of ${installer})`);
        return;
    }
    const listing = execFileSync(sevenZ, ['l', '-slt', installer], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const inner = [...listing.matchAll(/^Path = (.*app-[a-z0-9]+\.7z)$/gm)].map((match) => match[1] as string);
    if (inner.length === 0) {
        throw new Error(`${installer}: no app archive inside`);
    }
    const work = await mkdtemp(path.join(tmpdir(), 'xora-7z-'));
    try {
        for (const name of inner) {
            execFileSync(sevenZ, ['e', '-y', `-o${work}`, installer, name], { stdio: 'ignore' });
            const methods = execFileSync(sevenZ, ['l', '-slt', path.join(work, path.basename(name))], {
                encoding: 'utf8',
                maxBuffer: 64 << 20,
            });
            const unreadable = [...methods.matchAll(/^Method = (.*)$/gm)]
                .map((match) => match[1] as string)
                .filter((method) => /\bARM/.test(method));
            if (unreadable.length > 0) {
                throw new Error(`${installer}: ${name} uses ${unreadable[0]}, which the installer cannot unpack`);
            }
        }
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}

if (!values['skip-build']) {
    run('pnpm', ['build'], repoRoot);
    run('pnpm', ['bundle'], repoRoot);
}
for (const target of targets) {
    console.log(`\n=== ${target}`);
    const started = Date.now();
    run(
        'pnpm',
        [
            'exec',
            'electron-builder',
            '--config',
            'electron-builder.yml',
            ...(TARGETS[target] ?? []),
            '--publish',
            'never',
        ],
        desktopDir,
    );
    if (target.startsWith('win-')) {
        const arch = target.slice('win-'.length);
        const installer = readdirSync(releaseDir).find((name) => name.endsWith(`-win-${arch}.exe`));
        if (!installer) throw new Error(`no ${target} installer in ${releaseDir}`);
        await checkWindowsArchive(path.join(releaseDir, installer));
    }
    const made = readdirSync(releaseDir).filter(
        (name) => INSTALLER.test(name) && statSync(path.join(releaseDir, name)).mtimeMs >= started,
    );
    if (made.length === 0) throw new Error(`${target}: electron-builder wrote no installer`);
    console.log(`made ${made.join(', ')}`);
}

const sums: string[] = [];
for (const name of readdirSync(releaseDir)
    .filter((file) => INSTALLER.test(file))
    .sort()) {
    const digest = createHash('sha256')
        .update(await readFile(path.join(releaseDir, name)))
        .digest('hex');
    sums.push(`${digest}  ${name}`);
}
await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`\n${sums.join('\n')}`);
