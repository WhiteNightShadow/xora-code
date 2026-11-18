import { z } from 'zod';
import { closestLines, locateLoosely } from '../match.ts';
import { resolveToolPath } from '../path.ts';
import { detectEol, encodeText, type TextEncoding, withEol, writeFileAtomic } from '../text.ts';
import { truncateLine } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { isToolResult, loadExisting, lossyMessage, noteChanged, seenState } from './files.ts';
import { describeError, displayPath, errorResult, FILE_ALIASES, notFoundMessage, numberedLine } from './shared.ts';

export interface EditSpec {
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll?: boolean | undefined;
}

export type EditOutcome =
    | {
          readonly ok: true;
          readonly text: string;
          readonly replacements: number;
          /** Where the (first) replacement starts in `text`. */
          readonly index: number;
          /** The text put there: `newString`, in the file's line endings and, after a loose match, its indentation. */
          readonly inserted: string;
          /** How the place was found when `oldString` was not in the file exactly (21 §4.2). */
          readonly loose?: string;
      }
    | { readonly ok: false; readonly error: string };

function countOccurrences(text: string, needle: string): number {
    let count = 0;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        count++;
    }
    return count;
}

/** Lines of the file shown with an edit that missed, at most. */
const HINT_MAX_LINES = 15;

/** A line with its whitespace visible, as tabs and trailing spaces are what edits miss by. */
function visible(line: string): string {
    return JSON.stringify(truncateLine(line, 200));
}

/**
 * Why `oldString` was not found, with what the file has where it most likely aimed, so that the next edit can be
 * written from this message without reading the file again.
 */
function notFoundHint(text: string, edit: EditSpec): string {
    const parts = [
        'oldString was not found: it must be the text of the file exactly, including whitespace, indentation and line breaks.',
    ];
    const closest = closestLines(text, edit.oldString);
    if (closest) {
        const lines = text.split('\n');
        let from = closest.from;
        let to = closest.to;
        if (to - from + 1 > HINT_MAX_LINES) {
            from = Math.max(from, (closest.differs?.line ?? from) - 3);
            to = Math.min(to, from + HINT_MAX_LINES - 1);
        }
        const where = closest.from === closest.to ? `line ${closest.from}` : `lines ${closest.from}-${closest.to}`;
        if (closest.differs) {
            parts.push(
                `The closest text is at ${where}; line ${closest.differs.line} is the first that differs:`,
                `  in the file:  ${visible(closest.differs.inFile)}`,
                `  in oldString: ${visible(closest.differs.sent)}`,
            );
        } else {
            parts.push(`The closest text is at ${where}.`);
        }
        const shown: string[] = [];
        for (let n = from; n <= to; n++) {
            const line = lines[n - 1] ?? '';
            shown.push(numberedLine(n, truncateLine(line.endsWith('\r') ? line.slice(0, -1) : line, 300)));
        }
        parts.push(`The file there, to copy from (without the line numbers):\n${shown.join('\n')}`);
    } else {
        parts.push('Nothing in the file comes close to it: read the file again and copy the current text.');
    }
    if (edit.newString.trim().length >= 8 && text.includes(edit.newString)) {
        parts.push('newString already appears in the file; the change may have been made already.');
    }
    return parts.join('\n');
}

/**
 * Applies one exact-text replacement. Line endings need not match: in a CRLF file, `\n` in `oldString` and `newString`
 * stands for `\r\n`, so the file keeps its line endings. `$` in `newString` has no special meaning. When `oldString`
 * is not in the file exactly, the one place it fits apart from whitespace a model gets wrong is taken instead
 * (`locateLoosely`); `replaceAll` only ever replaces exact occurrences.
 */
export function applyEdit(text: string, edit: EditSpec): EditOutcome {
    if (edit.oldString === edit.newString) {
        return { ok: false, error: 'oldString and newString are identical; there is nothing to change.' };
    }
    if (edit.oldString === '') {
        return text === ''
            ? { ok: true, text: edit.newString, replacements: 1, index: 0, inserted: edit.newString }
            : { ok: false, error: 'oldString is empty but the file is not; give the exact text to replace.' };
    }
    const eol = detectEol(text);
    const converted = (target: '\n' | '\r\n'): EditSpec => ({
        oldString: withEol(edit.oldString, target),
        newString: withEol(edit.newString, target),
    });
    const variants = eol === '\r\n' ? [converted('\r\n'), edit] : [edit, converted('\n')];
    for (const variant of variants) {
        const count = countOccurrences(text, variant.oldString);
        if (count === 0) {
            continue;
        }
        if (count > 1 && edit.replaceAll !== true) {
            return {
                ok: false,
                error: `Found ${count} matches of oldString. Include more surrounding lines to make it unique, or set replaceAll to change every occurrence.`,
            };
        }
        const index = text.indexOf(variant.oldString);
        const result =
            edit.replaceAll === true
                ? text.split(variant.oldString).join(variant.newString)
                : text.slice(0, index) + variant.newString + text.slice(index + variant.oldString.length);
        if (result === text) {
            return { ok: false, error: 'The edit would not change the file.' };
        }
        return {
            ok: true,
            text: result,
            replacements: edit.replaceAll === true ? count : 1,
            index,
            inserted: variant.newString,
        };
    }
    if (edit.replaceAll !== true) {
        const loose = locateLoosely(text, edit.oldString, edit.newString);
        if (loose.kind === 'ambiguous') {
            return {
                ok: false,
                error: `oldString is not in the file exactly, and ${loose.how} it fits ${loose.lines.length} places (starting at lines ${loose.lines.slice(0, 8).join(', ')}). Include more surrounding lines, copied from the file as they are, so that only one place fits.`,
            };
        }
        if (loose.kind === 'found') {
            const { start, end, replacement, how } = loose.match;
            const result = text.slice(0, start) + replacement + text.slice(end);
            if (result === text) {
                return { ok: false, error: 'The edit would not change the file.' };
            }
            return { ok: true, text: result, replacements: 1, index: start, inserted: replacement, loose: how };
        }
    }
    return { ok: false, error: notFoundHint(text, edit) };
}

/** Applies edits in order, each to the result of the previous one; stops at the first that fails. */
export function applyEdits(
    text: string,
    edits: readonly EditSpec[],
):
    | {
          readonly ok: true;
          readonly text: string;
          readonly index: number;
          /** The edits that were matched loosely, by 0-based number, and how. */
          readonly loose: ReadonlyArray<{ readonly edit: number; readonly how: string }>;
      }
    | { ok: false; error: string; edit: number } {
    let current = text;
    let first = Number.POSITIVE_INFINITY;
    const loose: Array<{ edit: number; how: string }> = [];
    for (const [number, edit] of edits.entries()) {
        const outcome = applyEdit(current, edit);
        if (!outcome.ok) {
            return { ok: false, error: outcome.error, edit: number };
        }
        current = outcome.text;
        first = Math.min(first, outcome.index);
        if (outcome.loose !== undefined) {
            loose.push({ edit: number, how: outcome.loose });
        }
    }
    return { ok: true, text: current, index: Number.isFinite(first) ? first : 0, loose };
}

/** What the model is told when an edit went in although its `oldString` was not in the file exactly. */
function looseNote(how: string): string {
    return `oldString was not in the file exactly: it was matched ${how}. Check the lines below.`;
}

/** An edit may drop the file's final line break by accident; put it back. */
function keepFinalNewline(before: string, after: string): string {
    if (before.endsWith('\n') && after !== '' && !after.endsWith('\n')) {
        return after + detectEol(before);
    }
    return after;
}

const SNIPPET_CONTEXT = 3;
const SNIPPET_MAX_LINES = 40;

/** The changed region with a few lines around it, numbered like `read` output. */
function snippet(text: string, index: number, insertedText: string): { readonly text: string; readonly line: number } {
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') {
        // The final line break does not start another line.
        lines.pop();
    }
    const line = text.slice(0, index).split('\n').length;
    const changed = Math.max(1, insertedText.split('\n').length);
    const from = Math.max(1, line - SNIPPET_CONTEXT);
    const to = Math.min(lines.length, line + changed - 1 + SNIPPET_CONTEXT, from + SNIPPET_MAX_LINES - 1);
    const numbered: string[] = [];
    for (let n = from; n <= to; n++) {
        const content = lines[n - 1] ?? '';
        numbered.push(numberedLine(n, truncateLine(content.endsWith('\r') ? content.slice(0, -1) : content, 500)));
    }
    return { text: numbered.join('\n'), line };
}

/** For an edit that missed: the file is not as the model last saw it, which is the likeliest reason. */
async function staleHint(ctx: ToolContext, file: string): Promise<string> {
    return (await seenState(ctx, file)) === 'changed'
        ? '\nThe file has changed since you last read it: the user or another process wrote to it.'
        : '';
}

async function save(file: string, shown: string, text: string, encoding: TextEncoding): Promise<ToolResult | null> {
    try {
        await writeFileAtomic(file, encodeText(text, encoding));
        return null;
    } catch (error) {
        return errorResult(`Cannot write ${shown}: ${describeError(error)}`);
    }
}

/** What other harnesses call the parts of an exact-text replacement. */
const EDIT_ALIASES = {
    oldString: ['old_str', 'old_text', 'old_content', 'old', 'search', 'find', 'original'],
    newString: ['new_str', 'new_text', 'new_content', 'new', 'replace', 'replacement', 'replace_with', 'updated'],
    replaceAll: ['all', 'global', 'allow_multiple'],
} as const;

const EditInput = z.object({
    path: z.string().min(1).describe('File to edit: absolute, or relative to the working directory'),
    oldString: z.string().describe('Exact text to replace, copied from the file (without line-number prefixes)'),
    newString: z.string().describe('Text to put in its place; must differ from oldString'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence of oldString instead of exactly one'),
});

export type EditInput = z.infer<typeof EditInput>;

async function runEdit(input: EditInput, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveToolPath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, file);
    const existing = await loadExisting(file, shown);
    if (isToolResult(existing)) {
        return existing;
    }
    if (existing.state === 'binary') {
        return errorResult(`${shown} is a binary file and cannot be edited as text.`);
    }
    if (existing.state === 'missing' && input.oldString !== '') {
        return errorResult(`${await notFoundMessage(file, shown)}. To create a file, use write.`);
    }
    if (existing.state === 'text' && existing.file.lossy) {
        return errorResult(lossyMessage(shown));
    }
    const before = existing.state === 'text' ? existing.file.text : '';
    const outcome = applyEdit(before, input);
    if (!outcome.ok) {
        return errorResult(`Cannot edit ${shown}: ${outcome.error}${await staleHint(ctx, file)}`);
    }
    const after = keepFinalNewline(before, outcome.text);
    const known = existing.state === 'missing' ? 'created' : await seenState(ctx, file);
    const failed = await save(file, shown, after, existing.state === 'text' ? existing.file.encoding : 'utf8');
    if (failed !== null) {
        return failed;
    }
    await noteChanged(ctx, file, known);
    const view = snippet(after, outcome.index, outcome.inserted);
    const what =
        existing.state === 'missing'
            ? `Created ${shown}.`
            : `Edited ${shown}: ${outcome.replacements} ${outcome.replacements === 1 ? 'replacement' : 'replacements'}.`;
    const loose = outcome.loose === undefined ? '' : ` ${looseNote(outcome.loose)}`;
    return {
        content: `${what}${loose} Lines around the ${outcome.replacements > 1 ? 'first ' : ''}change now read:\n${view.text}`,
        display: {
            kind: 'diff',
            diffs: [{ path: file, oldText: existing.state === 'missing' ? null : before, newText: after }],
        },
        locations: [{ path: file, line: view.line }],
    };
}

export const editTool: ToolDefinition<EditInput> = {
    name: 'edit',
    description: [
        'Replace exact text in a file. `oldString` must match the file exactly, including whitespace and indentation (copy it from `read` output, without the line-number prefix), and must occur exactly once unless `replaceAll` is set; include enough surrounding lines to make it unique.',
        '- Read the file first. Line endings (LF or CRLF) are handled for you.',
        '- Prefer this over `write` for changes to existing files; for several changes to one file use `multi_edit`.',
        '- An empty `oldString` creates a file that does not exist yet.',
    ].join('\n'),
    kind: 'edit',
    schema: EditInput,
    readOnly: false,
    lenient: { aliases: { path: FILE_ALIASES, ...EDIT_ALIASES } },
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path)],
    title: (input) => `Edit ${input.path}`,
    run: runEdit,
};

const MultiEditInput = z.object({
    path: z.string().min(1).describe('File to edit: absolute, or relative to the working directory'),
    edits: z
        .array(
            z.object({
                oldString: z.string().describe('Exact text to replace'),
                newString: z.string().describe('Text to put in its place'),
                replaceAll: z.boolean().optional().describe('Replace every occurrence instead of exactly one'),
            }),
        )
        .min(1)
        .describe('Edits applied in order, each to the result of the previous one'),
});

export type MultiEditInput = z.infer<typeof MultiEditInput>;

async function runMultiEdit(input: MultiEditInput, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveToolPath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, file);
    const existing = await loadExisting(file, shown);
    if (isToolResult(existing)) {
        return existing;
    }
    if (existing.state === 'binary') {
        return errorResult(`${shown} is a binary file and cannot be edited as text.`);
    }
    if (existing.state === 'missing' && input.edits[0]?.oldString !== '') {
        return errorResult(
            `${await notFoundMessage(file, shown)}. To create a file, use write, or start with an edit whose oldString is empty.`,
        );
    }
    if (existing.state === 'text' && existing.file.lossy) {
        return errorResult(lossyMessage(shown));
    }
    const before = existing.state === 'text' ? existing.file.text : '';
    const outcome = applyEdits(before, input.edits);
    if (!outcome.ok) {
        return errorResult(
            `Edit ${outcome.edit + 1} of ${input.edits.length} failed: ${outcome.error} No changes were written to ${shown}.${await staleHint(ctx, file)}`,
        );
    }
    const after = keepFinalNewline(before, outcome.text);
    const known = existing.state === 'missing' ? 'created' : await seenState(ctx, file);
    const failed = await save(file, shown, after, existing.state === 'text' ? existing.file.encoding : 'utf8');
    if (failed !== null) {
        return failed;
    }
    await noteChanged(ctx, file, known);
    const count = input.edits.length;
    const line = after.slice(0, outcome.index).split('\n').length;
    const loose = outcome.loose
        .map(({ edit, how }) => `\nIn edit ${edit + 1}, oldString was not in the file exactly: it was matched ${how}.`)
        .join('');
    return {
        content: `${existing.state === 'missing' ? 'Created' : 'Edited'} ${shown}: applied ${count} ${count === 1 ? 'edit' : 'edits'}.${loose}`,
        display: {
            kind: 'diff',
            diffs: [{ path: file, oldText: existing.state === 'missing' ? null : before, newText: after }],
        },
        locations: [{ path: file, line }],
    };
}

export const multiEditTool: ToolDefinition<MultiEditInput> = {
    name: 'multi_edit',
    description:
        'Make several exact-text replacements in one file in a single step. Edits are applied in order, each to the result of the previous one, with the same rules as `edit`; if any edit fails, nothing is written. ' +
        'Prefer it over several `edit` calls on the same file. Read the file first.',
    kind: 'edit',
    schema: MultiEditInput,
    readOnly: false,
    lenient: { aliases: { path: FILE_ALIASES, edits: ['changes', 'replacements', 'operations'], ...EDIT_ALIASES } },
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path)],
    title: (input) => `Edit ${input.path} (${input.edits.length} ${input.edits.length === 1 ? 'change' : 'changes'})`,
    run: runMultiEdit,
};
