import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../path.ts';

/**
 * Which language server serves which files, and where its executable is. Servers are not shipped with Xora: they
 * are looked up in the project's `node_modules/.bin` (only in a trusted project, since that runs code from the
 * repository) and then on PATH.
 */

export interface ServerCommand {
    /** A name looked up as described above, or an absolute path used as it is. */
    readonly command: string;
    readonly args: readonly string[];
}

export interface ServerSpec {
    /** Stable id; servers are shared by (id, root). */
    readonly id: string;
    /** What the model is told the server is called. */
    readonly name: string;
    /** The language as people name it, for messages. */
    readonly language: string;
    /** Executables to try, in order. */
    readonly commands: readonly ServerCommand[];
    /** File extension (lower case, with the dot) → LSP language id. */
    readonly extensions: Readonly<Record<string, string>>;
    /** How to install the server, passed on to the model when it is missing. */
    readonly install: string;
    /** The server is distributed through npm, so a project may have it in `node_modules/.bin`. */
    readonly nodeModules?: boolean;
    /**
     * Files that mark the root this server should be started in, looked for from the file's directory up to the
     * workspace root; without a match the workspace root is used.
     */
    readonly rootMarkers?: readonly string[];
    /**
     * Paths in the workspace (relative to a directory between the file and the workspace root) that the server loads
     * and runs when present, such as the project's own TypeScript. In an untrusted project such a server is not
     * started.
     */
    readonly projectCode?: readonly string[];
    /** `initializationOptions` of `initialize`; `trusted` tells whether the project is trusted. */
    readonly initializationOptions?: (trusted: boolean) => unknown;
}

/** The servers Xora knows (04 §3). */
export const DEFAULT_SERVERS: readonly ServerSpec[] = [
    {
        id: 'typescript',
        name: 'typescript-language-server',
        language: 'TypeScript/JavaScript',
        commands: [{ command: 'typescript-language-server', args: ['--stdio'] }],
        extensions: {
            '.ts': 'typescript',
            '.mts': 'typescript',
            '.cts': 'typescript',
            '.tsx': 'typescriptreact',
            '.js': 'javascript',
            '.mjs': 'javascript',
            '.cjs': 'javascript',
            '.jsx': 'javascriptreact',
        },
        install: 'npm install -g typescript-language-server typescript',
        nodeModules: true,
        // It prefers the TypeScript in the workspace's node_modules over its own.
        projectCode: ['node_modules/typescript'],
    },
    {
        id: 'python',
        name: 'pyright',
        language: 'Python',
        commands: [
            { command: 'pyright-langserver', args: ['--stdio'] },
            { command: 'basedpyright-langserver', args: ['--stdio'] },
        ],
        extensions: { '.py': 'python', '.pyi': 'python' },
        install: 'npm install -g pyright, or pip install basedpyright',
        nodeModules: true,
    },
    {
        id: 'go',
        name: 'gopls',
        language: 'Go',
        commands: [{ command: 'gopls', args: [] }],
        extensions: { '.go': 'go' },
        install: 'go install golang.org/x/tools/gopls@latest',
        rootMarkers: ['go.work', 'go.mod'],
    },
    {
        id: 'rust',
        name: 'rust-analyzer',
        language: 'Rust',
        commands: [{ command: 'rust-analyzer', args: [] }],
        extensions: { '.rs': 'rust' },
        install: 'rustup component add rust-analyzer',
        rootMarkers: ['Cargo.toml'],
        // Build scripts and proc macros are code from the project.
        initializationOptions: (trusted) =>
            trusted ? undefined : { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } },
    },
    {
        id: 'clangd',
        name: 'clangd',
        language: 'C/C++',
        commands: [{ command: 'clangd', args: [] }],
        extensions: {
            '.c': 'c',
            '.h': 'c',
            '.cc': 'cpp',
            '.cpp': 'cpp',
            '.cxx': 'cpp',
            '.c++': 'cpp',
            '.hh': 'cpp',
            '.hpp': 'cpp',
            '.hxx': 'cpp',
            '.ipp': 'cpp',
            '.m': 'objective-c',
            '.mm': 'objective-cpp',
        },
        install: 'clangd from LLVM (macOS: xcode-select --install; Debian/Ubuntu: apt install clangd)',
    },
];

/** The server for `file` and the language id to open it with, by extension. */
export function serverFor(
    servers: readonly ServerSpec[],
    file: string,
): { readonly spec: ServerSpec; readonly languageId: string } | undefined {
    const extension = path.extname(file).toLowerCase();
    if (extension === '') {
        return undefined;
    }
    for (const spec of servers) {
        const languageId = spec.extensions[extension];
        if (languageId !== undefined) {
            return { spec, languageId };
        }
    }
    return undefined;
}

/** The innermost of `roots` that contains `file`. */
export function workspaceRootOf(file: string, roots: readonly string[]): string | undefined {
    let best: string | undefined;
    for (const root of roots) {
        if (isPathInside(root, file) && (best === undefined || root.length > best.length)) {
            best = root;
        }
    }
    return best;
}

/** Directories from the one holding `file` up to `root`, innermost first. */
function directoriesUpTo(file: string, root: string): string[] {
    const dirs: string[] = [];
    let dir = path.dirname(file);
    for (;;) {
        dirs.push(dir);
        if (!isPathInside(root, dir) || path.resolve(dir) === path.resolve(root)) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return dirs.filter((candidate) => isPathInside(root, candidate));
}

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

async function isExecutable(file: string): Promise<boolean> {
    try {
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return (await stat(file)).isFile();
    } catch {
        return false;
    }
}

/** The root a server for `file` should run in: the nearest directory with a root marker, else the workspace root. */
export async function serverRoot(spec: ServerSpec, file: string, workspaceRoot: string): Promise<string> {
    if (spec.rootMarkers !== undefined) {
        for (const dir of directoriesUpTo(file, workspaceRoot)) {
            for (const marker of spec.rootMarkers) {
                if (await exists(path.join(dir, marker))) {
                    return dir;
                }
            }
        }
    }
    return workspaceRoot;
}

/** The first `projectCode` path that exists between the file and the workspace root, if any. */
export async function projectCodeIn(
    spec: ServerSpec,
    file: string,
    workspaceRoot: string,
): Promise<string | undefined> {
    for (const dir of directoriesUpTo(file, workspaceRoot)) {
        for (const relative of spec.projectCode ?? []) {
            const candidate = path.join(dir, ...relative.split('/'));
            if (await exists(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

/** File names a command may have: on Windows with an extension from PATHEXT, since that is what can be started. */
function executableNames(command: string, env: Readonly<Record<string, string | undefined>>): string[] {
    if (process.platform !== 'win32') {
        return [command];
    }
    const pathext = env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD';
    return pathext
        .split(';')
        .filter((extension) => extension !== '')
        .map((extension) => command + extension.toLowerCase());
}

export interface ResolvedCommand {
    readonly path: string;
    readonly args: readonly string[];
    /** Where it was found. */
    readonly source: 'project' | 'path' | 'absolute';
}

/** A server installed in the project: `node_modules/.bin` from the file's directory up to the workspace root. */
export async function findProjectCommand(
    spec: ServerSpec,
    file: string,
    workspaceRoot: string,
    env: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedCommand | undefined> {
    if (spec.nodeModules !== true) {
        return undefined;
    }
    for (const dir of directoriesUpTo(file, workspaceRoot)) {
        for (const { command, args } of spec.commands) {
            for (const name of executableNames(command, env)) {
                const candidate = path.join(dir, 'node_modules', '.bin', name);
                if (await isExecutable(candidate)) {
                    return { path: candidate, args, source: 'project' };
                }
            }
        }
    }
    return undefined;
}

/** A server installed on the machine: an absolute command as it is, a name on PATH. */
export async function findInstalledCommand(
    spec: ServerSpec,
    env: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedCommand | undefined> {
    const searchPath = env.PATH ?? env.Path ?? '';
    for (const { command, args } of spec.commands) {
        if (path.isAbsolute(command)) {
            if (await isExecutable(command)) {
                return { path: command, args, source: 'absolute' };
            }
            continue;
        }
        for (const dir of searchPath.split(path.delimiter)) {
            // Relative PATH entries would resolve against the workspace, which is the project's code again.
            if (dir === '' || !path.isAbsolute(dir)) {
                continue;
            }
            for (const name of executableNames(command, env)) {
                const candidate = path.join(dir, name);
                if (await isExecutable(candidate)) {
                    return { path: candidate, args, source: 'path' };
                }
            }
        }
    }
    return undefined;
}
