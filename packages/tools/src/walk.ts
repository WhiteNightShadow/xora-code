import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Directory traversal for `list`, `glob` and `grep`, honouring `.gitignore` files the way ripgrep does: the files of
 * enclosing directories (up to the repository root) and of every directory below apply, deeper ones win, and a
 * directory that was asked for explicitly is searched even when an enclosing ignore file excludes it. Symbolic links
 * are reported but never followed.
 */

/** Directory names that are never entered, whatever the ignore files say. */
export const ALWAYS_SKIPPED: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface WalkEntry {
    /** Absolute path. */
    readonly path: string;
    /** Path below the walk root, with `/` separators. */
    readonly relative: string;
    readonly name: string;
    readonly kind: EntryKind;
}

interface Matcher {
    readonly rules: Ignore;
    /** Turns a path relative to the walk root into one relative to the directory of the ignore file. */
    readonly local: (relative: string) => string;
}

const newIgnore = (): Ignore => ignore({ ignorecase: false });

const NO_MATCH = { ignored: false, unignored: false } as const;

/** `rules.test`, except that names the `ignore` package rejects (such as `...`) match nothing instead of throwing. */
function testPath(rules: Ignore, pathname: string): { readonly ignored: boolean; readonly unignored: boolean } {
    try {
        return rules.test(pathname);
    } catch {
        return NO_MATCH;
    }
}

async function readIgnoreFile(dir: string): Promise<Ignore | null> {
    try {
        return newIgnore().add(await readFile(path.join(dir, '.gitignore'), 'utf8'));
    } catch {
        return null;
    }
}

async function exists(file: string): Promise<boolean> {
    try {
        await stat(file);
        return true;
    } catch {
        return false;
    }
}

/** Directories above `root` whose ignore files apply to it, outermost first: up to the repository root, if any. */
async function enclosingDirectories(root: string): Promise<string[]> {
    const dirs: string[] = [];
    if (await exists(path.join(root, '.git'))) {
        return dirs;
    }
    for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
        dirs.push(dir);
        if ((await exists(path.join(dir, '.git'))) || path.dirname(dir) === dir) {
            return dirs.reverse();
        }
    }
}

const toPosix = (p: string): string => (path.sep === '\\' ? p.replaceAll('\\', '/') : p);

/** The ignore rules in effect for one directory of a walk. Create them with `IgnoreRules.load`. */
export class IgnoreRules {
    readonly #matchers: readonly Matcher[];
    readonly #extra: Ignore | null;

    constructor(matchers: readonly Matcher[] = [], extra: Ignore | null = null) {
        this.#matchers = matchers;
        this.#extra = extra;
    }

    /**
     * Rules for a walk starting at `root`: the ignore files of enclosing directories, plus `extra` gitignore-style
     * patterns relative to `root`. The root's own `.gitignore` is added by `forDirectory` like any other.
     */
    static async load(root: string, extra: readonly string[] = []): Promise<IgnoreRules> {
        const matchers: Matcher[] = [];
        for (const dir of await enclosingDirectories(root)) {
            const rules = await readIgnoreFile(dir);
            if (rules === null) {
                continue;
            }
            const prefix = `${toPosix(path.relative(dir, root))}/`;
            if (testPath(rules, prefix).ignored) {
                // The root itself is ignored from above, yet it was asked for: drop the rules from above.
                matchers.length = 0;
                continue;
            }
            matchers.push({ rules, local: (relative) => prefix + relative });
        }
        return new IgnoreRules(matchers, extra.length > 0 ? newIgnore().add([...extra]) : null);
    }

    /** The rules for the directory at `relative` (`''` for the root), whose entries include `.gitignore` or not. */
    async forDirectory(dir: string, relative: string, hasIgnoreFile: boolean): Promise<IgnoreRules> {
        const rules = hasIgnoreFile ? await readIgnoreFile(dir) : null;
        if (rules === null) {
            return this;
        }
        const strip = relative === '' ? 0 : relative.length + 1;
        return new IgnoreRules([...this.#matchers, { rules, local: (entry) => entry.slice(strip) }], this.#extra);
    }

    /** Whether the entry at `relative` (below the walk root) is ignored. */
    ignores(relative: string, isDirectory: boolean): boolean {
        const candidate = isDirectory ? `${relative}/` : relative;
        if (this.#extra !== null && testPath(this.#extra, candidate).ignored) {
            return true;
        }
        let ignored = false;
        for (const matcher of this.#matchers) {
            const result = testPath(matcher.rules, matcher.local(candidate));
            if (result.ignored) {
                ignored = true;
            } else if (result.unignored) {
                ignored = false;
            }
        }
        return ignored;
    }
}

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function kindOf(entry: Dirent): EntryKind {
    if (entry.isDirectory()) {
        return 'directory';
    }
    if (entry.isFile()) {
        return 'file';
    }
    return entry.isSymbolicLink() ? 'symlink' : 'other';
}

export interface DirectoryListing {
    /** Entries that are not ignored, sorted by name. */
    readonly entries: readonly WalkEntry[];
    /** Rules for the entries' own subdirectories. */
    readonly rules: IgnoreRules;
}

/** Reads one directory of a walk; unreadable directories come back empty. */
export async function readDirectory(dir: string, relative: string, rules: IgnoreRules): Promise<DirectoryListing> {
    let dirents: Dirent[];
    try {
        dirents = await readdir(dir, { withFileTypes: true });
    } catch {
        return { entries: [], rules };
    }
    const local = await rules.forDirectory(
        dir,
        relative,
        dirents.some((entry) => entry.name === '.gitignore' && !entry.isDirectory()),
    );
    const entries: WalkEntry[] = [];
    for (const dirent of dirents.sort((a, b) => compareNames(a.name, b.name))) {
        const kind = kindOf(dirent);
        const entryRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
        if (ALWAYS_SKIPPED.has(dirent.name) || local.ignores(entryRelative, kind === 'directory')) {
            continue;
        }
        entries.push({ path: path.join(dir, dirent.name), relative: entryRelative, name: dirent.name, kind });
    }
    return { entries, rules: local };
}

export interface WalkOptions {
    readonly signal?: AbortSignal;
    /** Extra gitignore-style patterns, relative to the root. */
    readonly ignore?: readonly string[];
}

/**
 * Every entry below `root`, depth first with the entries of each directory sorted by name, which is the order of
 * `rg --sort path`. Directories are yielded before their contents.
 */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
    const rules = await IgnoreRules.load(root, options.ignore);
    yield* walkDirectory(root, '', rules, options.signal);
}

async function* walkDirectory(
    dir: string,
    relative: string,
    rules: IgnoreRules,
    signal: AbortSignal | undefined,
): AsyncGenerator<WalkEntry> {
    signal?.throwIfAborted();
    const listing = await readDirectory(dir, relative, rules);
    for (const entry of listing.entries) {
        yield entry;
        if (entry.kind === 'directory') {
            yield* walkDirectory(entry.path, entry.relative, listing.rules, signal);
        }
    }
}
