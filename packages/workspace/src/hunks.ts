import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { looksBinary, lstatOrUndefined, nativePath, splitNul } from './files.ts';
import { assertRevision, GitError, requireGitRoot, runGit } from './git.ts';

export type DiffLineKind = ' ' | '+' | '-';

export interface DiffLine {
    readonly kind: DiffLineKind;
    /** The line without its prefix and newline, decoded as UTF-8. */
    readonly text: string;
    readonly oldLine?: number;
    readonly newLine?: number;
    /** The line ends its file without a newline (`\ No newline at end of file`). */
    readonly noNewline?: boolean;
}

export interface DiffHunk {
    /** `<index>-<hash>`: the position in the file plus a hash of the header and body, so a stale id never matches. */
    readonly id: string;
    /** The `@@ … @@` line. */
    readonly header: string;
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: readonly DiffLine[];
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface DiffFile {
    /** Paths relative to the repository root; equal unless the file was renamed or copied. */
    readonly oldPath: string;
    readonly newPath: string;
    readonly status: DiffFileStatus;
    readonly binary: boolean;
    readonly oldMode?: string;
    readonly newMode?: string;
    readonly hunks: readonly DiffHunk[];
}

export interface BuildPatchOptions {
    /** Build the patch that undoes the hunks: it applies to the new side and produces the old one. */
    readonly reverse?: boolean;
}

export interface ReviewDiffOptions {
    /** Compare the index with HEAD (or with `base`) instead of the work tree with the index. */
    readonly staged?: boolean;
    /** Compare with this commit instead, for example the merge-base of the branch. */
    readonly base?: string;
    /** Append untracked, non-ignored files as added files (work tree views only). */
    readonly untracked?: boolean;
}

/** A hunk patch that git refused; nothing was changed. */
export class HunkApplyError extends Error {
    readonly stderr: string;

    constructor(message: string, stderr: string) {
        super(stderr.trim() ? `${message}: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : message);
        this.name = 'HunkApplyError';
        this.stderr = stderr;
    }
}

/*
 * Diffs are parsed as latin1 "byte strings" (one char per byte) so that patches rebuilt from them reproduce the
 * original bytes even for files that are not valid UTF-8; the public `text` and path fields are UTF-8 decoded.
 * The raw values live in these maps rather than on the objects, which stay plain and serialisable.
 */
const rawFiles = new WeakMap<DiffFile, { readonly name: string }>();
const rawHunks = new WeakMap<DiffHunk, { readonly section: string; readonly lines: readonly string[] }>();

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const UNTRACKED_TEXT_LIMIT = 8 * 1024 * 1024;

const fromBytes = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');

/** UTF-8 text as a byte string; refuses text that already lost bytes to U+FFFD replacement. */
function toBytes(text: string): string {
    if (text.includes('�')) {
        throw new Error('diff text is not byte-exact; parse the diff again from git output');
    }
    return Buffer.from(text, 'utf8').toString('latin1');
}

const C_ESCAPES: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
};

/** Decodes git's C-style quoting of a path that starts at `text[0] === '"'`. */
function unquote(text: string): { value: string; end: number } {
    let value = '';
    let index = 1;
    while (index < text.length) {
        const char = text[index] as string;
        if (char === '"') {
            return { value, end: index + 1 };
        }
        if (char !== '\\') {
            value += char;
            index++;
            continue;
        }
        const next = text[index + 1] ?? '';
        const simple = C_ESCAPES[next];
        if (simple !== undefined) {
            value += simple;
            index += 2;
        } else if (/[0-7]/.test(next)) {
            const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1))?.[0] ?? next;
            value += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
            index += 1 + octal.length;
        } else {
            value += next;
            index += 2;
        }
    }
    return { value, end: text.length };
}

/** Quotes a path the way git does with `core.quotepath=false`: only for quotes, backslashes and control bytes. */
function quote(name: string): string {
    let needsQuotes = false;
    let quoted = '"';
    for (const char of name) {
        const code = char.charCodeAt(0);
        if (char === '"' || char === '\\') {
            needsQuotes = true;
            quoted += `\\${char}`;
        } else if (code < 0x20 || code === 0x7f) {
            needsQuotes = true;
            const named = Object.entries(C_ESCAPES).find(([, value]) => value === char)?.[0];
            quoted += named ? `\\${named}` : `\\${code.toString(8).padStart(3, '0')}`;
        } else {
            quoted += char;
        }
    }
    return needsQuotes ? `${quoted}"` : name;
}

function stripPrefix(name: string, prefix: string): string {
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** A `---`/`+++` name: null for /dev/null, otherwise without the a/ or b/ prefix and any trailing tab section. */
function parseName(text: string, prefix: string): string | null {
    let name: string;
    if (text.startsWith('"')) {
        name = unquote(text).value;
    } else {
        const tab = text.indexOf('\t');
        name = tab === -1 ? text : text.slice(0, tab);
    }
    return name === '/dev/null' ? null : stripPrefix(name, prefix);
}

function parseGitHeader(rest: string): { a: string; b: string } | undefined {
    if (rest.startsWith('"')) {
        const first = unquote(rest);
        const remainder = rest.slice(first.end).trimStart();
        const second = remainder.startsWith('"') ? unquote(remainder).value : remainder;
        return { a: stripPrefix(first.value, 'a/'), b: stripPrefix(second, 'b/') };
    }
    const quoted = rest.indexOf(' "');
    if (quoted !== -1 && rest.endsWith('"')) {
        return {
            a: stripPrefix(rest.slice(0, quoted), 'a/'),
            b: stripPrefix(unquote(rest.slice(quoted + 1)).value, 'b/'),
        };
    }
    // Unquoted names may contain spaces; git writes such a header only when both names are the same.
    if (rest.length % 2 === 1) {
        const half = (rest.length - 1) / 2;
        const a = stripPrefix(rest.slice(0, half), 'a/');
        const b = stripPrefix(rest.slice(half + 1), 'b/');
        if (rest[half] === ' ' && a === b) {
            return { a, b };
        }
    }
    const split = rest.indexOf(' b/');
    return split === -1 ? undefined : { a: stripPrefix(rest.slice(0, split), 'a/'), b: rest.slice(split + 3) };
}

interface FileHeader {
    gitNames?: { a: string; b: string };
    oldName?: string | null;
    newName?: string | null;
    renameFrom?: string;
    renameTo?: string;
    copied?: boolean;
    status?: DiffFileStatus;
    oldMode?: string;
    newMode?: string;
    indexMode?: string;
    binary: boolean;
}

function readHeaderLine(header: FileHeader, line: string): void {
    const value = (prefix: string): string => line.slice(prefix.length);
    const pathValue = (prefix: string): string => {
        const text = value(prefix);
        return text.startsWith('"') ? unquote(text).value : text;
    };
    if (line.startsWith('old mode ')) {
        header.oldMode = value('old mode ');
    } else if (line.startsWith('new mode ')) {
        header.newMode = value('new mode ');
    } else if (line.startsWith('new file mode ')) {
        header.status = 'added';
        header.newMode = value('new file mode ');
    } else if (line.startsWith('deleted file mode ')) {
        header.status = 'deleted';
        header.oldMode = value('deleted file mode ');
    } else if (line.startsWith('rename from ')) {
        header.status = 'renamed';
        header.renameFrom = pathValue('rename from ');
    } else if (line.startsWith('rename to ')) {
        header.renameTo = pathValue('rename to ');
    } else if (line.startsWith('copy from ')) {
        header.status = 'copied';
        header.renameFrom = pathValue('copy from ');
    } else if (line.startsWith('copy to ')) {
        header.renameTo = pathValue('copy to ');
    } else if (line.startsWith('index ')) {
        header.indexMode = /^index \S+ (\d+)$/.exec(line)?.[1];
    } else if (line.startsWith('--- ')) {
        header.oldName = parseName(value('--- '), 'a/');
    } else if (line.startsWith('+++ ')) {
        header.newName = parseName(value('+++ '), 'b/');
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        header.binary = true;
    }
}

function parseHunk(
    lines: readonly string[],
    start: number,
    ordinal: number,
): { hunk: DiffHunk; next: number } | undefined {
    const headerLine = lines[start] ?? '';
    const match = HUNK_HEADER.exec(headerLine);
    if (!match) {
        return undefined;
    }
    const oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    let oldLines = match[2] === undefined ? 1 : Number(match[2]);
    let newLines = match[4] === undefined ? 1 : Number(match[4]);
    let oldLeft = oldLines;
    let newLeft = newLines;
    let oldNumber = oldStart;
    let newNumber = newStart;
    const parsed: DiffLine[] = [];
    const raw: string[] = [];
    const markLast = (): void => {
        const last = parsed.at(-1);
        if (last) {
            parsed[parsed.length - 1] = { ...last, noNewline: true };
        }
    };
    let index = start + 1;
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const line = lines[index] as string;
        // Some tools strip the space from empty context lines.
        const kind = line === '' ? ' ' : line[0];
        const text = line.slice(1);
        if (kind === '\\') {
            markLast();
        } else if (kind === ' ' && oldLeft > 0 && newLeft > 0) {
            parsed.push({ kind, text: fromBytes(text), oldLine: oldNumber++, newLine: newNumber++ });
            raw.push(text);
            oldLeft--;
            newLeft--;
        } else if (kind === '-' && oldLeft > 0) {
            parsed.push({ kind, text: fromBytes(text), oldLine: oldNumber++ });
            raw.push(text);
            oldLeft--;
        } else if (kind === '+' && newLeft > 0) {
            parsed.push({ kind, text: fromBytes(text), newLine: newNumber++ });
            raw.push(text);
            newLeft--;
        } else {
            break;
        }
        index++;
    }
    if (lines[index]?.startsWith('\\')) {
        markLast();
        index++;
    }
    // A truncated hunk keeps the lines it has.
    oldLines -= oldLeft;
    newLines -= newLeft;
    const digest = createHash('sha1').update(lines.slice(start, index).join('\n'), 'latin1').digest('hex').slice(0, 8);
    const hunk: DiffHunk = {
        id: `${ordinal}-${digest}`,
        header: fromBytes(headerLine),
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: parsed,
    };
    rawHunks.set(hunk, { section: match[5] ?? '', lines: raw });
    return { hunk, next: index };
}

function parseFile(lines: readonly string[], start: number, git: boolean, files: DiffFile[]): number {
    const header: FileHeader = { binary: false };
    let index = start;
    if (git) {
        header.gitNames = parseGitHeader((lines[index] ?? '').slice('diff --git '.length));
        index++;
    }
    for (; index < lines.length; index++) {
        const line = lines[index] as string;
        if (line.startsWith('@@ ') || line.startsWith('diff --git ') || (!git && header.newName !== undefined)) {
            break;
        }
        readHeaderLine(header, line);
    }
    const hunks: DiffHunk[] = [];
    while (lines[index]?.startsWith('@@ ')) {
        const parsed = parseHunk(lines, index, hunks.length);
        if (!parsed) {
            break;
        }
        hunks.push(parsed.hunk);
        index = parsed.next;
    }
    let status = header.status;
    if (status === undefined) {
        status = header.oldName === null ? 'added' : header.newName === null ? 'deleted' : 'modified';
    }
    let oldName = header.renameFrom ?? header.oldName ?? header.gitNames?.a;
    let newName = header.renameTo ?? header.newName ?? header.gitNames?.b;
    oldName ??= newName ?? '';
    newName ??= oldName;
    if (status === 'added') {
        oldName = newName;
    } else if (status === 'deleted') {
        newName = oldName;
    }
    const oldMode = header.oldMode ?? (status === 'added' ? undefined : header.indexMode);
    const newMode = header.newMode ?? (status === 'deleted' ? undefined : header.indexMode);
    const file: DiffFile = {
        oldPath: fromBytes(oldName),
        newPath: fromBytes(newName),
        status,
        binary: header.binary,
        ...(oldMode ? { oldMode } : {}),
        ...(newMode ? { newMode } : {}),
        hunks,
    };
    rawFiles.set(file, { name: newName });
    files.push(file);
    return Math.max(index, start + 1);
}

/**
 * Parses unified diffs (git's extended format or plain `diff -u`). Pass git's raw output as bytes to keep
 * patches built from the result byte-exact for files that are not UTF-8.
 */
export function parseUnifiedDiff(input: string | Uint8Array): DiffFile[] {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
    const lines = bytes.toString('latin1').split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    const files: DiffFile[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] as string;
        if (line.startsWith('diff --git ')) {
            index = parseFile(lines, index, true, files);
        } else if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
            index = parseFile(lines, index, false, files);
        } else {
            index++;
        }
    }
    return files;
}

const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`);

const flip = (kind: DiffLineKind): DiffLineKind => (kind === '+' ? '-' : kind === '-' ? '+' : kind);

/** A `---`/`+++` name line; git adds a tab after names with spaces so that GNU patch reads them whole. */
function nameLine(marker: string, name: string): string {
    const quoted = quote(name);
    return `${marker} ${quoted}${quoted === name && name.includes(' ') ? '\t' : ''}`;
}

function buildPatchBytes(file: DiffFile, hunkIds: readonly string[], reverse: boolean): Buffer {
    const label = file.newPath;
    if (file.binary) {
        throw new Error(`cannot build a hunk patch for binary file ${label}`);
    }
    const wanted = new Set(hunkIds);
    const selected = file.hunks.filter((hunk) => wanted.has(hunk.id));
    if (selected.length !== wanted.size) {
        const missing = [...wanted].filter((id) => !file.hunks.some((hunk) => hunk.id === id));
        throw new Error(`unknown hunk ${missing.join(', ')} in ${label}; the diff is probably stale`);
    }
    const wholeFile = file.status === 'added' || file.status === 'deleted';
    if (wholeFile && selected.length !== file.hunks.length) {
        throw new Error(`the content of ${file.status} file ${label} cannot be split`);
    }
    if (!wholeFile && selected.length === 0) {
        throw new Error(`no hunks selected in ${label}`);
    }
    // Hunks act on the content only: a renamed (or copied) file is patched in place at its new path, and mode
    // changes are left out.
    const name = rawFiles.get(file)?.name ?? toBytes(file.newPath);
    let kind = file.status === 'added' || file.status === 'deleted' ? file.status : 'modified';
    if (reverse && kind !== 'modified') {
        kind = kind === 'added' ? 'deleted' : 'added';
    }
    const out = [`diff --git ${quote(`a/${name}`)} ${quote(`b/${name}`)}`];
    const mode = (file.status === 'added' ? file.newMode : file.oldMode) ?? '100644';
    if (kind === 'added') {
        out.push(`new file mode ${mode}`);
    } else if (kind === 'deleted') {
        out.push(`deleted file mode ${mode}`);
    }
    if (selected.length > 0) {
        out.push(kind === 'added' ? '--- /dev/null' : nameLine('---', `a/${name}`));
        out.push(kind === 'deleted' ? '+++ /dev/null' : nameLine('+++', `b/${name}`));
    }
    // Source positions stay as they are: they are exact for the side the patch applies to. git applies hunks in
    // order to one image and searches from the target start, so target starts are recomputed from the hunks that
    // are actually included.
    let delta = 0;
    for (const hunk of selected) {
        const raw = rawHunks.get(hunk) ?? {
            section: toBytes(hunk.header.replace(/^@@ [^@]* @@/, '')),
            lines: hunk.lines.map((line) => toBytes(line.text)),
        };
        const sourceStart = reverse ? hunk.newStart : hunk.oldStart;
        const sourceCount = reverse ? hunk.newLines : hunk.oldLines;
        const targetCount = reverse ? hunk.oldLines : hunk.newLines;
        const before = (sourceCount === 0 ? sourceStart : sourceStart - 1) + delta;
        const targetStart = targetCount === 0 ? before : before + 1;
        delta += targetCount - sourceCount;
        out.push(`@@ -${range(sourceStart, sourceCount)} +${range(targetStart, targetCount)} @@${raw.section}`);
        hunk.lines.forEach((line, index) => {
            out.push((reverse ? flip(line.kind) : line.kind) + (raw.lines[index] ?? ''));
            if (line.noNewline) {
                out.push('\\ No newline at end of file');
            }
        });
    }
    return Buffer.from(`${out.join('\n')}\n`, 'latin1');
}

/**
 * A patch with only the selected hunks of one file. Hunks of an added or deleted file cannot be split, renamed
 * files are patched at their new path, and mode changes are left out.
 */
export function buildPatch(file: DiffFile, hunkIds: readonly string[], options: BuildPatchOptions = {}): string {
    return buildPatchBytes(file, hunkIds, options.reverse === true).toString('utf8');
}

/** Checks the patch first so that a patch that no longer fits changes nothing. */
async function applyPatch(repoDir: string, patch: Buffer, cached: boolean): Promise<void> {
    const root = await requireGitRoot(repoDir);
    const args = ['apply', '--whitespace=nowarn', '--no-ignore-whitespace', ...(cached ? ['--cached'] : [])];
    const check = await runGit([...args, '--check', '-'], { cwd: root, input: patch, eol: 'user' });
    if (check.code !== 0) {
        throw new HunkApplyError('the hunks no longer apply', check.stderr);
    }
    const applied = await runGit([...args, '-'], { cwd: root, input: patch, eol: 'user' });
    if (applied.code !== 0) {
        throw new HunkApplyError('applying the hunks failed', applied.stderr);
    }
}

/** Stages hunks of a file from the unstaged view (`diffForReview(repo)`). */
export async function stageHunks(repoDir: string, file: DiffFile, hunkIds: readonly string[]): Promise<void> {
    await applyPatch(repoDir, buildPatchBytes(file, hunkIds, false), true);
}

/** Unstages hunks of a file from the staged view (`diffForReview(repo, { staged: true })`). */
export async function unstageHunks(repoDir: string, file: DiffFile, hunkIds: readonly string[]): Promise<void> {
    // The reversed patch applies to the index as it is now, so its positions are exact (unlike `apply -R`, which
    // would search from positions in HEAD).
    await applyPatch(repoDir, buildPatchBytes(file, hunkIds, true), true);
}

/**
 * Reverts hunks in the work tree, from a view whose new side is the work tree (the unstaged view or a `base`
 * view). The index is left alone.
 */
export async function revertHunks(repoDir: string, file: DiffFile, hunkIds: readonly string[]): Promise<void> {
    await applyPatch(repoDir, buildPatchBytes(file, hunkIds, true), false);
}

/** A git-style "new file" diff for an untracked file, as a byte string. */
async function untrackedDiff(root: string, relative: string): Promise<string | undefined> {
    const absolute = nativePath(root, relative);
    const info = await lstatOrUndefined(absolute);
    if (!info) {
        return undefined;
    }
    let mode: string;
    let data: Buffer | undefined;
    if (info.isSymbolicLink()) {
        mode = '120000';
        data = await readlink(absolute, { encoding: 'buffer' });
    } else if (info.isFile()) {
        mode = process.platform !== 'win32' && (info.mode & 0o111) !== 0 ? '100755' : '100644';
        data = info.size > UNTRACKED_TEXT_LIMIT ? undefined : await readFile(absolute);
    } else {
        // Nested repositories and special files have no content to show.
        return undefined;
    }
    const name = Buffer.from(relative, 'utf8').toString('latin1');
    const header = `diff --git ${quote(`a/${name}`)} ${quote(`b/${name}`)}\nnew file mode ${mode}\n`;
    if (data === undefined || looksBinary(data)) {
        return `${header}Binary files /dev/null and ${quote(`b/${name}`)} differ\n`;
    }
    if (data.length === 0) {
        return header;
    }
    const body = data.toString('latin1');
    const complete = body.endsWith('\n');
    const lines = (complete ? body.slice(0, -1) : body).split('\n');
    return (
        `${header}--- /dev/null\n${nameLine('+++', `b/${name}`)}\n@@ -0,0 +${range(1, lines.length)} @@\n` +
        lines.map((line) => `+${line}\n`).join('') +
        (complete ? '' : '\\ No newline at end of file\n')
    );
}

/**
 * Parsed changes for the review panel: unstaged (work tree against the index, the default), staged (index against
 * HEAD) or against a `base` commit. Paths are relative to the repository root.
 */
export async function diffForReview(repoDir: string, options: ReviewDiffOptions = {}): Promise<DiffFile[]> {
    const root = await requireGitRoot(repoDir);
    const args = [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--unified=3',
        '--ignore-submodules=dirty',
        '-M',
    ];
    if (options.staged) {
        args.push('--cached');
    }
    if (options.base !== undefined) {
        assertRevision(options.base);
        args.push(options.base);
    }
    args.push('--');
    const result = await runGit(args, { cwd: root, eol: 'user' });
    if (result.code !== 0) {
        throw new GitError(args, result.code, result.stderr);
    }
    const files = parseUnifiedDiff(result.stdout);
    if (options.untracked && !options.staged) {
        const listed = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, eol: 'user' });
        if (listed.code !== 0) {
            throw new GitError(['ls-files'], listed.code, listed.stderr);
        }
        const diffs: string[] = [];
        for (const relative of splitNul(listed.stdout)) {
            const diff = await untrackedDiff(root, relative);
            if (diff !== undefined) {
                diffs.push(diff);
            }
        }
        files.push(...parseUnifiedDiff(Buffer.from(diffs.join(''), 'latin1')));
    }
    return files;
}
