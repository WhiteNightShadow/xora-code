import { rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { detectEol, encodeText, readTextFile, type TextEncoding, writeFileAtomic } from '../text.ts';
import type { FileDiff, ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { describeError, displayPath, errorCode, errorResult } from './shared.ts';

/**
 * The patch format of OpenAI's codex (`apply_patch`), which many models are trained to write:
 *
 *     *** Begin Patch
 *     *** Add File: <path>          followed by the file's lines, each prefixed with `+`
 *     *** Delete File: <path>
 *     *** Update File: <path>
 *     *** Move to: <path>           optional, renames the updated file
 *     @@ <context line>             optional, repeatable: a line above the change that narrows down where it is
 *      <context>  -<removed>  +<added>
 *     *** End of File               optional, the chunk ends at the end of the file
 *     *** End Patch
 *
 * Chunks are located the way codex does it: an exact match first, then ignoring trailing whitespace, then ignoring
 * surrounding whitespace, then also treating typographic dashes, quotes and spaces as their ASCII forms.
 */

export interface PatchChunk {
    /** `@@` lines that narrow down where the chunk applies, outermost first. */
    readonly contexts: readonly string[];
    readonly oldLines: readonly string[];
    readonly newLines: readonly string[];
    /** The chunk ends at the end of the file. */
    readonly endOfFile: boolean;
}

export type PatchOperation =
    | { readonly type: 'add'; readonly path: string; readonly content: string }
    | { readonly type: 'delete'; readonly path: string }
    | {
          readonly type: 'update';
          readonly path: string;
          readonly moveTo?: string | undefined;
          readonly chunks: readonly PatchChunk[];
      };

export type ParsedPatch =
    | { readonly ok: true; readonly operations: readonly PatchOperation[] }
    | { readonly ok: false; readonly error: string };

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File:(.*)$/;
const MOVE_HEADER = /^\*\*\* Move to:(.*)$/;

type ChunkParse =
    | { readonly ok: true; readonly chunk: PatchChunk; readonly next: number }
    | { readonly ok: false; readonly error: string; readonly line: number };

/**
 * The context of an `@@` line: a string, `null` for a bare `@@`, or `undefined` when the line is not one. Unified diff
 * headers (`@@ -12,7 +12,8 @@ function f()`) are accepted too; only the text after the ranges is used.
 */
function contextHeader(line: string): string | null | undefined {
    const unified = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.exec(line);
    if (unified !== null) {
        const text = unified[1]?.trim() ?? '';
        return text === '' ? null : text;
    }
    if (line.trimEnd() === '@@') {
        return null;
    }
    return line.startsWith('@@ ') ? line.slice(3) : undefined;
}

function parseChunk(lines: readonly string[], start: number, end: number, first: boolean): ChunkParse {
    let i = start;
    const contexts: string[] = [];
    let headers = 0;
    for (; i < end; i++) {
        const context = contextHeader(lines[i] ?? '');
        if (context === undefined) {
            break;
        }
        headers++;
        if (context !== null) {
            contexts.push(context);
        }
    }
    if (headers === 0 && !first) {
        return { ok: false, error: `Expected an @@ line to start the next chunk, found "${lines[i]}"`, line: i };
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;
    let count = 0;
    for (; i < end; i++) {
        const line = lines[i] ?? '';
        if (line.trim() === END_OF_FILE) {
            endOfFile = true;
            i++;
            break;
        }
        const marker = line[0];
        if (marker === undefined) {
            // A blank line stands for an empty context line.
            oldLines.push('');
            newLines.push('');
        } else if (marker === ' ') {
            oldLines.push(line.slice(1));
            newLines.push(line.slice(1));
        } else if (marker === '-') {
            oldLines.push(line.slice(1));
        } else if (marker === '+') {
            newLines.push(line.slice(1));
        } else if (count === 0) {
            return {
                ok: false,
                error: `Unexpected line "${line}": chunk lines start with " " (context), "-" (removed) or "+" (added)`,
                line: i,
            };
        } else {
            // The next chunk or file operation.
            break;
        }
        count++;
    }
    if (count === 0) {
        return { ok: false, error: 'A chunk has no lines', line: i };
    }
    return { ok: true, chunk: { contexts, oldLines, newLines, endOfFile }, next: i };
}

/** Parses a patch. Text around the `*** Begin Patch` … `*** End Patch` block, such as a heredoc wrapper, is ignored. */
export function parsePatch(text: string): ParsedPatch {
    const lines = text.split(/\r?\n/);
    const fail = (error: string): ParsedPatch => ({ ok: false, error });
    const begin = lines.findIndex((line) => line.trim() === BEGIN_PATCH);
    if (begin < 0) {
        return fail(`The patch must start with "${BEGIN_PATCH}".`);
    }
    let end = -1;
    for (let i = lines.length - 1; i > begin; i--) {
        if ((lines[i] ?? '').trim() === END_PATCH) {
            end = i;
            break;
        }
    }
    if (end < 0) {
        return fail(`The patch must end with "${END_PATCH}".`);
    }
    const operations: PatchOperation[] = [];
    let i = begin + 1;
    while (i < end) {
        const header = (lines[i] ?? '').trim();
        if (header === '') {
            i++;
            continue;
        }
        const match = FILE_HEADER.exec(header);
        if (match === null) {
            return fail(
                `"${header}" (patch line ${i + 1}) is not a file operation; expected "${ADD_FILE}<path>", "${DELETE_FILE}<path>" or "${UPDATE_FILE}<path>".`,
            );
        }
        const path = (match[2] ?? '').trim();
        if (path === '') {
            return fail(`Missing path in "${header}" (patch line ${i + 1}).`);
        }
        i++;
        if (match[1] === 'Add') {
            const content: string[] = [];
            for (; i < end && (lines[i] ?? '').startsWith('+'); i++) {
                content.push(`${(lines[i] ?? '').slice(1)}\n`);
            }
            operations.push({ type: 'add', path, content: content.join('') });
        } else if (match[1] === 'Delete') {
            operations.push({ type: 'delete', path });
        } else {
            let moveTo: string | undefined;
            const move = MOVE_HEADER.exec((lines[i] ?? '').trim());
            if (move !== null) {
                moveTo = (move[1] ?? '').trim();
                if (moveTo === '') {
                    return fail(`Missing path in "${MOVE_TO.trim()}" (patch line ${i + 1}).`);
                }
                i++;
            }
            const chunks: PatchChunk[] = [];
            while (i < end) {
                const line = lines[i] ?? '';
                if (line.trim() === '') {
                    i++;
                    continue;
                }
                if (line.startsWith('***')) {
                    break;
                }
                const parsed = parseChunk(lines, i, end, chunks.length === 0);
                if (!parsed.ok) {
                    return fail(`${parsed.error} (patch line ${parsed.line + 1}, in the update of ${path}).`);
                }
                chunks.push(parsed.chunk);
                i = parsed.next;
            }
            if (chunks.length === 0 && moveTo === undefined) {
                return fail(`The update of ${path} contains no changes.`);
            }
            operations.push({ type: 'update', path, moveTo, chunks });
        }
    }
    if (operations.length === 0) {
        return fail('The patch contains no file operations.');
    }
    return { ok: true, operations };
}

const PUNCTUATION: Readonly<Record<string, string>> = {
    '‐': '-',
    '‑': '-',
    '‒': '-',
    '–': '-',
    '—': '-',
    '―': '-',
    '−': '-',
    '‘': "'",
    '’': "'",
    '‚': "'",
    '‛': "'",
    '“': '"',
    '”': '"',
    '„': '"',
    '‟': '"',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    '　': ' ',
};

const PUNCTUATION_PATTERN = new RegExp(`[${Object.keys(PUNCTUATION).join('')}]`, 'g');

/** Fuzz levels, strictest first. */
const NORMALISERS: ReadonlyArray<(line: string) => string> = [
    (line) => line,
    (line) => line.trimEnd(),
    (line) => line.trim(),
    (line) => line.trim().replace(PUNCTUATION_PATTERN, (c) => PUNCTUATION[c] ?? c),
];

/**
 * Index at or after `start` where `pattern` occurs in `lines`, trying each fuzz level over all positions before the
 * next. A chunk marked end-of-file is first tried at the very end.
 */
export function seekSequence(
    lines: readonly string[],
    pattern: readonly string[],
    start: number,
    endOfFile: boolean,
): number | null {
    if (pattern.length === 0) {
        return start;
    }
    const last = lines.length - pattern.length;
    if (last < 0) {
        return null;
    }
    const scan = (from: number): number | null => {
        for (const normalise of NORMALISERS) {
            const wanted = pattern.map(normalise);
            for (let i = from; i <= last; i++) {
                if (wanted.every((line, k) => normalise(lines[i + k] ?? '') === line)) {
                    return i;
                }
            }
        }
        return null;
    };
    if (endOfFile) {
        const atEnd = scan(last);
        if (atEnd !== null) {
            return atEnd;
        }
    }
    return start <= last ? scan(start) : null;
}

type ApplyResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

/** Applies the chunks of one update to `text`, keeping its line endings and whether it ends with a line break. */
export function applyChunks(text: string, chunks: readonly PatchChunk[], shown: string): ApplyResult {
    const eol = detectEol(text);
    const finalBreak = text === '' || text.endsWith('\n');
    const lines = text.split('\n');
    if (eol === '\r\n') {
        for (const [index, line] of lines.entries()) {
            lines[index] = line.endsWith('\r') ? line.slice(0, -1) : line;
        }
    }
    if (lines.at(-1) === '') {
        lines.pop();
    }
    const replacements: Array<{ readonly start: number; readonly remove: number; readonly insert: readonly string[] }> =
        [];
    let cursor = 0;
    for (const [index, chunk] of chunks.entries()) {
        const where = chunks.length > 1 ? `${shown} (chunk ${index + 1})` : shown;
        for (const context of chunk.contexts) {
            const found = seekSequence(lines, [context], cursor, false);
            if (found === null) {
                return { ok: false, error: `Could not find the @@ line "${context}" in ${where}.` };
            }
            cursor = found + 1;
        }
        if (chunk.oldLines.length === 0) {
            // Only additions: after the @@ line when there is one, otherwise at the end of the file.
            replacements.push({
                start: chunk.contexts.length > 0 ? cursor : lines.length,
                remove: 0,
                insert: chunk.newLines,
            });
            continue;
        }
        let pattern = chunk.oldLines;
        let insert = chunk.newLines;
        let found = seekSequence(lines, pattern, cursor, chunk.endOfFile);
        if (found === null && pattern.at(-1) === '') {
            // A trailing empty line often stands for the final line break, which is not a line of its own here.
            pattern = pattern.slice(0, -1);
            if (insert.at(-1) === '') {
                insert = insert.slice(0, -1);
            }
            found = seekSequence(lines, pattern, cursor, chunk.endOfFile);
        }
        if (found === null) {
            return {
                ok: false,
                error: `Could not find the lines to change in ${where}:\n${chunk.oldLines.join('\n')}`,
            };
        }
        replacements.push({ start: found, remove: pattern.length, insert });
        cursor = found + pattern.length;
    }
    // From the bottom up, so that earlier positions stay valid.
    const ordered = replacements.map((replacement, order) => ({ ...replacement, order }));
    ordered.sort((a, b) => b.start - a.start || b.order - a.order);
    for (const replacement of ordered) {
        lines.splice(replacement.start, replacement.remove, ...replacement.insert);
    }
    let result = lines.join(eol);
    if (finalBreak && lines.length > 0) {
        result += eol;
    }
    return { ok: true, text: result };
}

interface FileState {
    readonly text: string;
    readonly encoding: TextEncoding;
    readonly mode?: number;
}

interface PlannedChange {
    readonly path: string;
    /** `null`: the file did not exist. */
    readonly before: FileState | null;
    /** `null`: the file is deleted. */
    readonly after: FileState | null;
    readonly movedFrom?: string;
}

class PatchError extends Error {}

/** Every absolute path the patch touches, move destinations included. */
export function patchTargets(operations: readonly PatchOperation[], cwd: string): string[] {
    const paths = new Set<string>();
    for (const operation of operations) {
        paths.add(resolveToolPath(cwd, operation.path));
        if (operation.type === 'update' && operation.moveTo !== undefined) {
            paths.add(resolveToolPath(cwd, operation.moveTo));
        }
    }
    return [...paths];
}

/** Applies every operation in memory, in order, and returns the resulting changes without writing anything. */
async function planPatch(operations: readonly PatchOperation[], cwd: string): Promise<PlannedChange[]> {
    const original = new Map<string, FileState | null>();
    const current = new Map<string, FileState | null>();
    const movedFrom = new Map<string, string>();
    const load = async (file: string): Promise<FileState | null> => {
        if (current.has(file)) {
            return current.get(file) ?? null;
        }
        const shown = displayPath(cwd, file);
        let state: FileState | null = null;
        try {
            const stats = await stat(file);
            if (stats.isDirectory()) {
                throw new PatchError(`${shown} is a directory.`);
            }
            const text = await readTextFile(file);
            if (text === null) {
                throw new PatchError(`${shown} is a binary file; it cannot be patched.`);
            }
            state = { ...text, mode: stats.mode & 0o7777 };
        } catch (error) {
            if (error instanceof PatchError) {
                throw error;
            }
            if (errorCode(error) !== 'ENOENT') {
                throw new PatchError(`Cannot read ${shown}: ${describeError(error)}`);
            }
        }
        original.set(file, state);
        current.set(file, state);
        return state;
    };

    for (const operation of operations) {
        const file = resolveToolPath(cwd, operation.path);
        const shown = displayPath(cwd, file);
        if (operation.type === 'add') {
            if ((await load(file)) !== null) {
                throw new PatchError(
                    `Cannot add ${shown}: it already exists. Use "${UPDATE_FILE}${operation.path}" to change it.`,
                );
            }
            current.set(file, { text: operation.content, encoding: 'utf8' });
        } else if (operation.type === 'delete') {
            if ((await load(file)) === null) {
                throw new PatchError(`Cannot delete ${shown}: no such file.`);
            }
            current.set(file, null);
        } else {
            const state = await load(file);
            if (state === null) {
                throw new PatchError(`Cannot update ${shown}: no such file.`);
            }
            const applied = applyChunks(state.text, operation.chunks, shown);
            if (!applied.ok) {
                throw new PatchError(applied.error);
            }
            const next: FileState = { ...state, text: applied.text };
            const destination = operation.moveTo === undefined ? file : resolveToolPath(cwd, operation.moveTo);
            if (destination !== file) {
                if ((await load(destination)) !== null) {
                    throw new PatchError(
                        `Cannot move ${shown} to ${displayPath(cwd, destination)}: the destination exists.`,
                    );
                }
                current.set(file, null);
                movedFrom.set(destination, movedFrom.get(file) ?? file);
            }
            current.set(destination, next);
        }
    }

    const changes: PlannedChange[] = [];
    for (const [file, after] of current) {
        const before = original.get(file) ?? null;
        const unchanged = before?.text === after?.text && before?.encoding === after?.encoding;
        if ((before === null && after === null) || (before !== null && after !== null && unchanged)) {
            continue;
        }
        const source = movedFrom.get(file);
        changes.push(
            source === undefined ? { path: file, before, after } : { path: file, before, after, movedFrom: source },
        );
    }
    return changes;
}

/** Writes the planned changes; if one fails, restores the files already written and rethrows. */
async function commit(changes: readonly PlannedChange[]): Promise<void> {
    // Writes before deletions, so that a failure never loses the content of a moved file.
    const ordered = [...changes.filter((c) => c.after !== null), ...changes.filter((c) => c.after === null)];
    const done: PlannedChange[] = [];
    try {
        for (const change of ordered) {
            if (change.after === null) {
                await rm(change.path);
            } else {
                await writeFileAtomic(change.path, encodeText(change.after.text, change.after.encoding), {
                    mode: change.after.mode,
                });
            }
            done.push(change);
        }
    } catch (error) {
        for (const change of done.reverse()) {
            try {
                if (change.before === null) {
                    await rm(change.path, { force: true });
                } else {
                    await writeFileAtomic(change.path, encodeText(change.before.text, change.before.encoding), {
                        mode: change.before.mode,
                    });
                }
            } catch {
                // Best effort: keep restoring the others.
            }
        }
        throw error;
    }
}

const ApplyPatchInput = z.object({
    patch: z.string().min(1).describe('The whole patch, from "*** Begin Patch" to "*** End Patch"'),
});

export type ApplyPatchInput = z.infer<typeof ApplyPatchInput>;

async function runApplyPatch(input: ApplyPatchInput, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parsePatch(input.patch);
    if (!parsed.ok) {
        return errorResult(`Invalid patch: ${parsed.error}`);
    }
    let changes: PlannedChange[];
    try {
        changes = await planPatch(parsed.operations, ctx.cwd);
    } catch (error) {
        const message = error instanceof PatchError ? error.message : describeError(error);
        return errorResult(`The patch does not apply: ${message}\nNo files were changed.`);
    }
    if (changes.length === 0) {
        return { content: 'The patch makes no changes; no files were written.' };
    }
    try {
        await commit(changes);
    } catch (error) {
        return errorResult(`Writing the patch failed: ${describeError(error)}. Files already written were restored.`);
    }

    const movedAway = new Set(changes.flatMap((change) => (change.movedFrom === undefined ? [] : [change.movedFrom])));
    const summary: string[] = [];
    const diffs: FileDiff[] = [];
    for (const change of changes) {
        const shown = displayPath(ctx.cwd, change.path);
        if (change.after === null) {
            if (!movedAway.has(change.path)) {
                summary.push(`D ${shown}`);
                diffs.push({ path: change.path, oldText: change.before?.text ?? '', newText: '', deleted: true });
            }
        } else if (change.movedFrom !== undefined) {
            const source = changes.find((other) => other.path === change.movedFrom);
            summary.push(`M ${shown} (moved from ${displayPath(ctx.cwd, change.movedFrom)})`);
            diffs.push({
                path: change.path,
                oldText: source?.before?.text ?? null,
                newText: change.after.text,
                movedFrom: change.movedFrom,
            });
        } else {
            summary.push(`${change.before === null ? 'A' : 'M'} ${shown}`);
            diffs.push({ path: change.path, oldText: change.before?.text ?? null, newText: change.after.text });
        }
    }
    return {
        content: `Success. Updated the following files:\n${summary.join('\n')}`,
        display: { kind: 'diff', diffs },
        locations: changes.filter((change) => change.after !== null).map((change) => ({ path: change.path })),
    };
}

export const applyPatchTool: ToolDefinition<ApplyPatchInput> = {
    name: 'apply_patch',
    description: [
        'Add, delete, update and rename files with one patch, applied atomically: if any part does not apply, nothing is written. Prefer it for coordinated changes across files. Format:',
        '',
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+every line of the new file, prefixed with +',
        '*** Delete File: src/old.ts',
        '*** Update File: src/app.ts',
        '*** Move to: src/main.ts',
        '@@ function start() {',
        ' unchanged line before the change',
        '-removed line',
        '+added line',
        ' unchanged line after the change',
        '*** End Patch',
        '',
        '- Paths are relative to the working directory. `*** Move to:` is optional and renames the updated file.',
        '- In an update, give about three unchanged lines before and after each change (prefixed with a space). Start each further chunk with an `@@` line; when the unchanged lines are not unique, put the enclosing class or function on that `@@` line, and use several consecutive `@@` lines to narrow it down further.',
        '- Add `*** End of File` after a chunk that ends at the end of the file.',
        '- The unchanged and removed lines must match the current file, so read it first.',
    ].join('\n'),
    kind: 'edit',
    schema: ApplyPatchInput,
    readOnly: false,
    targets: (input, ctx) => {
        const parsed = parsePatch(input.patch);
        return parsed.ok ? patchTargets(parsed.operations, ctx.cwd) : [];
    },
    title: (input) => {
        const parsed = parsePatch(input.patch);
        if (!parsed.ok) {
            return 'Apply patch';
        }
        const names = [...new Set(parsed.operations.map((operation) => operation.path))];
        const listed = names.slice(0, 3).join(', ');
        return names.length > 3 ? `Patch ${listed} and ${names.length - 3} more` : `Patch ${listed}`;
    },
    run: runApplyPatch,
};
