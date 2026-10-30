import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildOptions, build } from 'esbuild';
import { loadTrustedKeys } from '../../../build/keys.ts';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trustedKeys = await loadTrustedKeys();

await rm(path.join(desktopDir, 'dist'), { recursive: true, force: true });

const common: BuildOptions = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
    legalComments: 'none',
};

await build({
    ...common,
    entryPoints: [path.join(desktopDir, 'src/main/index.ts')],
    outfile: path.join(desktopDir, 'dist/main.cjs'),
    define: { __XORA_TRUSTED_KEYS__: JSON.stringify(trustedKeys) },
});
await build({
    ...common,
    entryPoints: [path.join(desktopDir, 'src/preload/app.ts')],
    outfile: path.join(desktopDir, 'dist/preload-app.cjs'),
});
await build({
    ...common,
    entryPoints: [path.join(desktopDir, 'src/preload/safe-mode.ts')],
    outfile: path.join(desktopDir, 'dist/preload-safe.cjs'),
});

console.log(`desktop shell built; trusted bundle keys: ${Object.keys(trustedKeys).join(', ')}`);
