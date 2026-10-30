import { lstat, readlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Path policy (docs/design/10-security.md §4): a tool may only touch paths inside the session's roots, judged on
 * real paths so that `..` and symbolic links cannot lead outside. The engine and the host call `checkPathAccess` on a
 * tool's `targets()` before running it; the tools themselves always work on the normalised path that
 * `resolveToolPath` returns.
 */

export type PathDenyReason = 'outside_roots' | 'symlink_escape' | 'device_path' | 'invalid';

export type PathAccess =
    | { readonly ok: true; readonly realPath: string }
    | { readonly ok: false; readonly reason: PathDenyReason };

export interface PathFlavor {
    /** `path.posix` or `path.win32`. */
    readonly path: path.PlatformPath;
    /** Whether names that differ only in case are the same file, as on default macOS and Windows volumes. */
    readonly caseInsensitive: boolean;
}

/** Path rules of a platform; the default is the one this process runs on. */
export function pathFlavor(platform: NodeJS.Platform = process.platform): PathFlavor {
    return {
        path: platform === 'win32' ? path.win32 : path.posix,
        caseInsensitive: platform === 'darwin' || platform === 'win32',
    };
}

/** Resolves a path given to a tool: relative paths start at `cwd`, and a leading `~` stands for the home directory. */
export function resolveToolPath(cwd: string, p: string, home: string = os.homedir()): string {
    if (p === '~') {
        return path.resolve(home);
    }
    if (p.startsWith('~/') || (path.sep === '\\' && p.startsWith('~\\'))) {
        return path.resolve(home, p.slice(2));
    }
    return path.resolve(cwd, p);
}

/** Whether `target` is `root` itself or lies below it. Both paths must be absolute. */
export function isPathInside(root: string, target: string, flavor: PathFlavor = pathFlavor()): boolean {
    const p = flavor.path;
    let base = p.resolve(root);
    let candidate = p.resolve(target);
    if (flavor.caseInsensitive) {
        base = base.toLowerCase();
        candidate = candidate.toLowerCase();
    }
    if (candidate === base) {
        return true;
    }
    return candidate.startsWith(base.endsWith(p.sep) ? base : base + p.sep);
}

type Win32Form = 'drive' | 'unc' | 'device' | 'relative';

function win32Form(p: string): Win32Form {
    if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(p) || p.startsWith('\\??\\')) {
        return 'device';
    }
    if (/^[\\/]{2}[^\\/]/.test(p)) {
        return 'unc';
    }
    return /^[a-zA-Z]:[\\/]/.test(p) ? 'drive' : 'relative';
}

/** Legacy DOS device names, which Windows opens as devices in any directory and with any extension. */
const RESERVED_WIN32_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;

function hasWin32DevicePart(p: string): boolean {
    // Past the drive letter or the leading `\\`, a colon can only introduce an alternate data stream.
    const rest = p.slice(2);
    if (rest.includes(':')) {
        return true;
    }
    return rest.split(/[\\/]/).some((part) => RESERVED_WIN32_NAME.test((part.split('.')[0] ?? '').trimEnd()));
}

/**
 * Checks that need no file system: the path must be absolute, and on Windows it must not be a device path
 * (`\\?\…`, `\\.\…`, `CON`, `NUL`, …), an alternate data stream (`file.txt:stream`) or a UNC path (`\\server\share`)
 * outside a UNC root. Returns why the path is refused, or `null`.
 */
export function checkPathSyntax(
    target: string,
    flavor: PathFlavor = pathFlavor(),
    roots: readonly string[] = [],
): 'device_path' | 'invalid' | null {
    if (target.length === 0 || target.includes('\0')) {
        return 'invalid';
    }
    if (flavor.path.sep !== '\\') {
        return flavor.path.isAbsolute(target) ? null : 'invalid';
    }
    const form = win32Form(target);
    if (form === 'device') {
        return 'device_path';
    }
    if (form === 'relative') {
        return 'invalid';
    }
    if (hasWin32DevicePart(target)) {
        return 'device_path';
    }
    if (form === 'unc' && !roots.some((root) => win32Form(root) === 'unc' && isPathInside(root, target, flavor))) {
        return 'device_path';
    }
    return null;
}

export interface PathAccessFacts {
    /** Allowed roots as configured. */
    readonly roots: readonly string[];
    /** Real paths of `roots`; defaults to `roots`. */
    readonly realRoots?: readonly string[];
    /** The requested absolute path. */
    readonly target: string;
    /** `target` with every symbolic link that exists resolved, as `realpathLoose` returns it. */
    readonly realTarget: string;
}

/**
 * The decision of `checkPathAccess`, as a pure function of paths that were already resolved, so the rules of every
 * platform can be tested anywhere. The real path decides; the requested path only tells a symlink escape apart from a
 * path that was outside to begin with.
 */
export function decidePathAccess(facts: PathAccessFacts, flavor: PathFlavor = pathFlavor()): PathAccess {
    const syntax = checkPathSyntax(facts.target, flavor, facts.roots);
    if (syntax !== null) {
        return { ok: false, reason: syntax };
    }
    const realRoots = facts.realRoots ?? facts.roots;
    if (realRoots.some((root) => isPathInside(root, facts.realTarget, flavor))) {
        return { ok: true, realPath: facts.realTarget };
    }
    const named = [...facts.roots, ...realRoots].some((root) => isPathInside(root, facts.target, flavor));
    return { ok: false, reason: named ? 'symlink_escape' : 'outside_roots' };
}

/**
 * Whether a tool may touch `target` (an absolute path) given the session's roots. Paths that do not exist yet are
 * judged by their nearest existing ancestor, and dangling symbolic links by where they point, since writing through
 * one creates its target.
 */
export async function checkPathAccess(roots: readonly string[], target: string): Promise<PathAccess> {
    const flavor = pathFlavor();
    // Before any file system call: on Windows even resolving a UNC or device path can reach out to the network.
    const syntax = checkPathSyntax(target, flavor, roots);
    if (syntax !== null) {
        return { ok: false, reason: syntax };
    }
    const resolved = path.resolve(target);
    let realTarget: string;
    try {
        realTarget = await realpathLoose(resolved);
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    const realRoots = await Promise.all(
        roots.map((root) => realpathLoose(path.resolve(root)).catch(() => path.resolve(root))),
    );
    return decidePathAccess({ roots, realRoots, target: resolved, realTarget }, flavor);
}

const MAX_SYMLINKS = 40;

/**
 * The real path of `target` even when it does not exist yet: every symbolic link on the way is resolved, dangling
 * ones included, and the missing part is appended as it is. Throws on symbolic link loops.
 */
export function realpathLoose(target: string): Promise<string> {
    return resolveReal(path.resolve(target), 0);
}

async function resolveReal(target: string, followed: number): Promise<string> {
    try {
        return await realpath(target);
    } catch {
        // Missing, a dangling or looping link, or not searchable: resolve what can be resolved below.
    }
    const parent = path.dirname(target);
    if (parent === target) {
        return target;
    }
    let isLink = false;
    try {
        isLink = (await lstat(target)).isSymbolicLink();
    } catch {
        // Does not exist.
    }
    const realParent = await resolveReal(parent, followed);
    if (!isLink) {
        return path.join(realParent, path.basename(target));
    }
    if (followed >= MAX_SYMLINKS) {
        throw new Error(`Too many levels of symbolic links: ${target}`);
    }
    return resolveReal(path.resolve(realParent, await readlink(target)), followed + 1);
}
