import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LspManager, type LspManagerOptions, lspTool, newDiagnostics, type ServerSpec } from '../src/index.ts';
import {
    eventually,
    isWindows,
    makeContext,
    processExists,
    runTool,
    type TestContext,
    temporaryDir,
    writeFiles,
} from './helpers.ts';

const FAKE_SERVER = fileURLToPath(new URL('./fake-lsp-server.mjs', import.meta.url));

function fakeSpec(args: readonly string[] = [], overrides: Partial<ServerSpec> = {}): ServerSpec {
    return {
        id: 'fake',
        name: 'fake-lsp',
        language: 'Fake',
        commands: [{ command: process.execPath, args: [FAKE_SERVER, ...args] }],
        extensions: { '.fake': 'fake' },
        install: 'it comes with the tests',
        ...overrides,
    };
}

const managers: LspManager[] = [];

afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
});

function manager(options: LspManagerOptions = {}): LspManager {
    const created = new LspManager({ servers: [fakeSpec()], settleMs: 100, ...options });
    managers.push(created);
    return created;
}

function context(cwd: string, lsp: LspManager, trusted = false): Promise<TestContext> {
    return makeContext(cwd, { lsp: { manager: lsp, trusted } });
}

const LIBRARY = 'class Greeter\n  def greet\ndef helper\n';
const MAIN = 'call helper\ncall greet twice\n';

describe('lsp tool', () => {
    it('finds definitions, references, hover text and symbols, with workspace paths and 1-based positions', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'src/lib.fake': LIBRARY, 'src/main.fake': MAIN });
        const lsp = manager();
        const ctx = await context(dir, lsp);

        const definition = await runTool(
            lspTool,
            { operation: 'definition', path: 'src/main.fake', line: 1, symbol: 'helper' },
            ctx,
        );
        expect(definition.isError).toBeUndefined();
        expect(definition.content).toBe('Definition of `helper` (src/main.fake:1:6):\nsrc/lib.fake:3:5: def helper');
        expect(definition.locations).toEqual([{ path: path.join(dir, 'src', 'lib.fake'), line: 3 }]);

        const references = await runTool(
            lspTool,
            { operation: 'references', path: 'src/lib.fake', line: 2, column: 9 },
            ctx,
        );
        expect(references.content).toBe(
            '2 references to `greet` in 2 files, the declaration included:\nsrc/lib.fake:2:7: def greet\nsrc/main.fake:2:6: call greet twice',
        );

        const hover = await runTool(lspTool, { operation: 'hover', path: 'src/main.fake', line: 1, column: 6 }, ctx);
        expect(hover.content).toBe('Hover for `helper` at src/main.fake:1:6:\n**helper** (fake)');

        const symbols = await runTool(lspTool, { operation: 'symbols', path: 'src/lib.fake' }, ctx);
        expect(symbols.content).toBe(
            'Symbols in src/lib.fake:\nclass Greeter (lines 1-2)\n  method greet: () (line 2)\nfunction helper: () (line 3)',
        );

        const search = await runTool(lspTool, { operation: 'symbols', path: 'src/main.fake', query: 'gre' }, ctx);
        expect(search.content).toBe(
            '2 symbols match "gre":\nclass Greeter: src/lib.fake:1:7\nmethod greet: src/lib.fake:2:7',
        );
        // One server for all of it.
        expect(lsp.running()).toHaveLength(1);
    });

    it('reports diagnostics of several files', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def ok\nerror boom here\nwarning careful\n', 'b.fake': 'def fine\n' });
        const ctx = await context(dir, manager());
        const result = await runTool(lspTool, { operation: 'diagnostics', path: 'a.fake', paths: ['b.fake'] }, ctx);
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe(
            'a.fake: 1 error, 1 warning (fake-lsp)\n  2:1 error E1: boom here\n  3:1 warning W1: careful\nb.fake: no problems (fake-lsp)',
        );
    });

    it('reads a server that writes its messages in small pieces', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def ünïcødé_free\nerror sp🚀ce\n' });
        const ctx = await context(dir, manager({ servers: [fakeSpec(['--chunked'])] }));
        const result = await runTool(lspTool, { operation: 'diagnostics', path: 'a.fake' }, ctx);
        expect(result.content).toBe('a.fake: 1 error (fake-lsp)\n  2:1 error E1: sp🚀ce');
    });

    it('checks its input before starting anything', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def one\n', 'notes.txt': 'text\n' });
        const lsp = manager();
        const ctx = await context(dir, lsp);
        const run = (input: Record<string, unknown>) => runTool(lspTool, input, ctx);
        expect((await run({ operation: 'hover', path: 'a.fake' })).content).toContain('needs `line`');
        expect((await run({ operation: 'hover', path: 'a.fake', line: 1 })).content).toContain('`column`');
        expect(
            (await run({ operation: 'definition', path: 'a.fake', paths: ['b.fake'], line: 1, column: 1 })).content,
        ).toContain('`paths` only works with the diagnostics operation');
        expect(lsp.running()).toHaveLength(0);
        expect((await run({ operation: 'hover', path: 'a.fake', line: 5, column: 1 })).content).toBe(
            'a.fake has 1 line; line 5 is past the end.',
        );
        expect((await run({ operation: 'hover', path: 'a.fake', line: 1, column: 30 })).content).toContain(
            'column 30 is past its end',
        );
        expect((await run({ operation: 'hover', path: 'a.fake', line: 1, symbol: 'two' })).content).toBe(
            '`two` does not appear on line 1 of a.fake, which reads: def one',
        );
        expect((await run({ operation: 'symbols', path: 'missing.fake' })).content).toBe(
            'File not found: missing.fake',
        );
        const unsupported = await run({ operation: 'symbols', path: 'notes.txt' });
        expect(unsupported.isError).toBe(true);
        expect(unsupported.content).toBe(
            'No language server handles .txt files (notes.txt). The lsp tool covers Fake (fake-lsp).',
        );
        expect(lsp.running()).toHaveLength(0);
    });

    it('refuses files outside the workspace without starting a server', async () => {
        const dir = await temporaryDir();
        const elsewhere = await temporaryDir();
        await writeFiles(elsewhere, { 'x.fake': 'def x\n' });
        const lsp = manager();
        const ctx = await context(dir, lsp);
        const result = await runTool(lspTool, { operation: 'symbols', path: path.join(elsewhere, 'x.fake') }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toContain('is outside the workspace');
        expect(lspTool.targets({ operation: 'symbols', path: 'a.fake', paths: ['../b.fake'] }, ctx)).toEqual([
            path.join(dir, 'a.fake'),
            path.resolve(dir, '..', 'b.fake'),
        ]);
        if (!isWindows) {
            await symlink(path.join(elsewhere, 'x.fake'), path.join(dir, 'link.fake'));
            const linked = await runTool(lspTool, { operation: 'diagnostics', path: 'link.fake' }, ctx);
            expect(linked.content).toBe(
                'link.fake is outside the workspace; language servers only look at files inside it.',
            );
        }
        expect(lsp.running()).toHaveLength(0);
    });

    it('says what to install when no server is found', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def a\n' });
        const missing = fakeSpec([], {
            commands: [{ command: 'xora-test-no-such-language-server', args: ['--stdio'] }],
            nodeModules: true,
        });
        const ctx = await context(dir, manager({ servers: [missing] }));
        const result = await runTool(lspTool, { operation: 'diagnostics', path: 'a.fake' }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toBe(
            "a.fake: No Fake language server was found: install fake-lsp (it comes with the tests) so that it is on PATH, or add it to the project's devDependencies.",
        );
    }, 30_000); // on Windows the search tries every PATH folder with every PATHEXT ending

    it('says when language servers are not available at all', async () => {
        const ctx = await makeContext(await temporaryDir());
        const result = await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, ctx);
        expect(result).toEqual({ content: 'Language servers are not available in this session.', isError: true });
    });
});

describe('lsp servers', () => {
    it('starts one server per root, shared by sessions, and stops it when idle', async () => {
        const dir = await temporaryDir();
        const other = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def a\n' });
        await writeFiles(other, { 'b.fake': 'def b\n' });
        const lsp = manager({ idleMs: 400 });
        const first = await context(dir, lsp);
        const second = await context(dir, lsp);
        await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, first);
        await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, second);
        expect(lsp.running()).toHaveLength(1);
        await runTool(lspTool, { operation: 'symbols', path: 'b.fake' }, await context(other, lsp));
        const pids = lsp.running().map((client) => client.pid ?? 0);
        expect(new Set(pids).size).toBe(2);
        expect(await eventually(() => lsp.running().length === 0, 5000)).toBe(true);
        expect(await eventually(() => pids.every((pid) => !processExists(pid)), 5000)).toBe(true);
    });

    it('kills the whole process tree of a server that ignores shutdown', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def a\n' });
        const pidFile = path.join(dir, 'child.pid');
        const lsp = manager({ servers: [fakeSpec([`--child=${pidFile}`, '--ignore-exit'])] });
        await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, await context(dir, lsp));
        const server = lsp.running()[0]?.pid ?? 0;
        const grandchild = Number(await readFile(pidFile, 'utf8'));
        expect(processExists(server)).toBe(true);
        expect(processExists(grandchild)).toBe(true);
        await lsp.shutdownAll();
        expect(await eventually(() => !processExists(server) && !processExists(grandchild), 5000)).toBe(true);
    }, 15_000);

    it('reports a crash, starts the server again, and gives up on one that keeps crashing', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def a\n' });
        const lsp = manager({ servers: [fakeSpec(['--crash-on=textDocument/hover'])] });
        const ctx = await context(dir, lsp);
        const hover = () => runTool(lspTool, { operation: 'hover', path: 'a.fake', line: 1, column: 5 }, ctx);
        const crashed = await hover();
        expect(crashed.isError).toBe(true);
        expect(crashed.content).toContain('fake-lsp exited with code 7');
        const symbols = await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, ctx);
        expect(symbols.content).toContain('function a');
        await hover();
        await hover();
        const refused = await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, ctx);
        expect(refused.isError).toBe(true);
        expect(refused.content).toContain('stopped unexpectedly 3 times');
    }, 15_000);

    it('times out requests and starts that get no answer', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def a\n' });
        const hanging = manager({ servers: [fakeSpec(['--hang-on=textDocument/hover'])], requestTimeoutMs: 300 });
        const hover = await runTool(
            lspTool,
            { operation: 'hover', path: 'a.fake', line: 1, column: 5 },
            await context(dir, hanging),
        );
        expect(hover.content).toBe(
            'fake-lsp did not answer the hover request within 300 ms; it may still be loading the project. Try again shortly.',
        );
        const slow = manager({ servers: [fakeSpec(['--slow-start=5000'])], startTimeoutMs: 300 });
        const started = await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, await context(dir, slow));
        expect(started.content).toContain('fake-lsp did not start');
        expect(started.content).toContain('initialize got no answer within 300 ms');
    }, 15_000);

    it('uses a server from node_modules/.bin only in a trusted project', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'src/a.fake': 'def a\n' });
        const bin = path.join(dir, 'node_modules', '.bin');
        await mkdir(bin, { recursive: true });
        if (isWindows) {
            await writeFile(path.join(bin, 'fake-lsp-bin.cmd'), `@"${process.execPath}" "${FAKE_SERVER}" %*\r\n`);
        } else {
            const script = path.join(bin, 'fake-lsp-bin');
            await writeFile(script, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "$@"\n`);
            await chmod(script, 0o755);
        }
        const spec = fakeSpec([], { commands: [{ command: 'fake-lsp-bin', args: [] }], nodeModules: true });
        const env = { ...process.env, PATH: path.dirname(process.execPath) };
        const lsp = manager({ servers: [spec], env });
        const input = { operation: 'symbols', path: 'src/a.fake' };
        const untrusted = await runTool(lspTool, input, await context(dir, lsp, false));
        expect(untrusted.isError).toBe(true);
        expect(untrusted.content).toContain('The project has one in node_modules/.bin/fake-lsp-bin');
        expect(untrusted.content).toContain('servers from the project only run once the project is trusted');
        const trusted = await runTool(lspTool, input, await context(dir, lsp, true));
        expect(trusted.content).toBe('Symbols in src/a.fake:\nfunction a: () (line 1)');
    });

    it('does not start a server that would load code from an untrusted project', async () => {
        const dir = await temporaryDir();
        await writeFiles(dir, { 'a.fake': 'def a\n', 'node_modules/fake-runtime/index.js': '' });
        const lsp = manager({ servers: [fakeSpec([], { projectCode: ['node_modules/fake-runtime'] })] });
        const untrusted = await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, await context(dir, lsp));
        expect(untrusted.isError).toBe(true);
        expect(untrusted.content).toContain('fake-lsp would load node_modules/fake-runtime from the project');
        expect(lsp.running()).toHaveLength(0);
        const trusted = await runTool(lspTool, { operation: 'symbols', path: 'a.fake' }, await context(dir, lsp, true));
        expect(trusted.content).toContain('function a');
    });
});

describe('diagnostics after edits', () => {
    async function setup(options: LspManagerOptions = {}) {
        const dir = await temporaryDir();
        const file = path.join(dir, 'src', 'x.fake');
        await writeFiles(dir, { 'src/x.fake': '' });
        const lsp = manager(options);
        const edit = (text: string | null) =>
            lsp.diagnosticsAfterEdit([{ path: file, text }], { roots: [dir], trusted: false, cwd: dir });
        return { dir, file, lsp, edit };
    }

    it('lists the errors of a file the server had not seen, then only the new ones', async () => {
        const { edit } = await setup();
        expect(await edit('def a\nerror first\n')).toBe(
            'LSP diagnostics after the edit:\nsrc/x.fake: 1 error (fake-lsp)\n  2:1 error E1: first',
        );
        expect(await edit('def a\nerror first\nerror second\nwarning careful\n')).toBe(
            'LSP diagnostics after the edit:\nsrc/x.fake: 1 new error, 1 new warning (fake-lsp)\n  3:1 error E1: second\n  4:1 warning W1: careful\n  (and 1 error from before the edit, not listed)',
        );
        // The first error moves down a line: still not new.
        expect(await edit('def zero\ndef a\nerror first\nerror second\n')).toBe(
            'LSP diagnostics after the edit:\nsrc/x.fake: no new errors, 2 errors left (fake-lsp)',
        );
        expect(await edit('def a\n')).toBe('LSP diagnostics after the edit:\nsrc/x.fake: no errors left (fake-lsp)');
        expect(await edit('def a\ndef b\n')).toBeUndefined();
    });

    it('caps what it lists', async () => {
        const { edit } = await setup();
        const errors = Array.from({ length: 14 }, (_, index) => `error number ${index + 1}`);
        const warnings = Array.from({ length: 7 }, (_, index) => `warning number ${index + 1}`);
        const note = (await edit(`${[...errors, ...warnings].join('\n')}\n`)) ?? '';
        expect(note.split('\n').filter((line) => line.includes(' error E1:'))).toHaveLength(10);
        expect(note.split('\n').filter((line) => line.includes(' warning W1:'))).toHaveLength(5);
        expect(note).toContain('src/x.fake: 14 errors, 7 warnings (fake-lsp)');
        expect(note).toContain('… 6 more not shown; use the lsp tool (diagnostics) to see all');
    });

    it('takes reports that arrive in steps, also without versions', async () => {
        const { edit } = await setup({ servers: [fakeSpec(['--two-phase', '--no-version'])], settleMs: 400 });
        expect(await edit('error broken\nwarning odd\n')).toBe(
            'LSP diagnostics after the edit:\nsrc/x.fake: 1 error, 1 warning (fake-lsp)\n  1:1 error E1: broken\n  2:1 warning W1: odd',
        );
    });

    it('gives up after the wait and does not hold up the edit', async () => {
        const { edit, lsp, file } = await setup({ servers: [fakeSpec(['--delay=3000'])], editWaitMs: 400 });
        const started = Date.now();
        expect(await edit('error late\n')).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1500);
        // The file was still sent; its report shows up later.
        expect(lsp.running()[0]?.isOpen(file)).toBe(true);
    });

    it('skips files without a server and closes deleted files', async () => {
        const { dir, file, lsp, edit } = await setup();
        expect(
            await lsp.diagnosticsAfterEdit([{ path: path.join(dir, 'notes.txt'), text: 'error x\n' }], {
                roots: [dir],
                trusted: false,
                cwd: dir,
            }),
        ).toBeUndefined();
        expect(lsp.running()).toHaveLength(0);
        await edit('def a\n');
        expect(lsp.running()[0]?.isOpen(file)).toBe(true);
        expect(await edit(null)).toBeUndefined();
        expect(lsp.running()[0]?.isOpen(file)).toBe(false);
    });

    it('matches problems one to one, ignoring where they are', () => {
        const at = (line: number, message: string) => ({
            range: { start: { line, character: 0 }, end: { line, character: 1 } },
            severity: 1,
            message,
        });
        expect(newDiagnostics([at(1, 'a'), at(2, 'b')], [at(5, 'a'), at(6, 'a'), at(7, 'b')])).toEqual([at(6, 'a')]);
    });
});
