import { execFileSync } from 'node:child_process';
import { cp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

/**
 * Packs the UI smoke and the update drill for a test machine that has neither the repository nor the signing key
 * (13 §2): each script as one file, playwright-core next to them, and the drill's update bundles made and signed
 * here.
 *
 *   node build/vm/harness.ts [out]        default dist/vm-harness; then on the test machine, with Node 24:
 *   node <out>/drill.mjs --app <exe> --bundles <out>/bundles
 *   node <out>/ui-smoke.mjs --app <exe>
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { positionals } = parseArgs({ allowPositionals: true });
const out = path.resolve(positionals[0] ?? path.join(repoRoot, 'dist', 'vm-harness'));

await rm(out, { recursive: true, force: true });
await build({
    entryPoints: {
        'ui-smoke': path.join(repoRoot, 'build', 'ui-smoke.ts'),
        drill: path.join(repoRoot, 'build', 'drill.ts'),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outdir: out,
    outExtension: { '.js': '.mjs' },
    // playwright-core loads its own files at run time: it ships as it is, next to the scripts.
    external: ['playwright-core'],
    // CommonJS dependencies inside an ES module bundle still call require.
    banner: {
        js: "import { createRequire as xoraRequire } from 'node:module'; const require = xoraRequire(import.meta.url);",
    },
    logLevel: 'warning',
});
const playwright = path.dirname(
    createRequire(path.join(repoRoot, 'package.json')).resolve('playwright-core/package.json'),
);
await cp(playwright, path.join(out, 'node_modules', 'playwright-core'), { recursive: true, dereference: true });
await writeFile(path.join(out, 'package.json'), '{ "type": "module" }\n');
execFileSync(process.execPath, [path.join(repoRoot, 'build', 'drill.ts'), '--prepare', path.join(out, 'bundles')], {
    stdio: 'inherit',
});
console.log(`harness → ${path.relative(repoRoot, out)}`);
