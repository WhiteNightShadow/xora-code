import { cp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Packs the evaluation for the VM, which has Node 24 but not the repository's dependencies: the runner, the UI
 * watcher and the xora engine as one file each, playwright-core and the tasks next to them.
 *
 *   node evals/build.ts        → dist/eval/{run.mjs, ui-team.mjs, engine.cjs, node_modules/, tasks/}
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repoRoot, 'dist', 'eval');

await rm(out, { recursive: true, force: true });
await build({
    entryPoints: { run: path.join(repoRoot, 'evals', 'run.ts'), 'ui-team': path.join(repoRoot, 'evals', 'ui-team.ts') },
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
await build({
    entryPoints: [path.join(repoRoot, 'packages', 'engine', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(out, 'engine.cjs'),
    logLevel: 'warning',
});
await cp(path.join(repoRoot, 'evals', 'tasks'), path.join(out, 'tasks'), { recursive: true });
const playwright = path.dirname(createRequire(path.join(repoRoot, 'package.json')).resolve('playwright-core/package.json'));
await cp(playwright, path.join(out, 'node_modules', 'playwright-core'), { recursive: true, dereference: true });
await writeFile(path.join(out, 'package.json'), '{ "type": "module" }\n');
console.log(`eval → ${path.relative(repoRoot, out)}`);
