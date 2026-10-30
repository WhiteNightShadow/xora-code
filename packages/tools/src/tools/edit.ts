import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { detectEol, encodeText, type TextEncoding, withEol, writeFileAtomic } from '../text.ts';
import { truncateLine } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { isToolResult, loadExisting } from './files.ts';
import { describeError, displayPath, errorResult, notFoundMessage, numberedLine } from './shared.ts';

export interface EditSpec {
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll?: boolean | undefined;
}

export type EditOutcome =
    | { readonly ok: true; readonly text: string; readonly replacements: number; readonly index: number }
    | { readonly ok: false; readonly error: string };

function countOccurrences(text: string, needle: string): number {
    let count = 0;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        count++;
    }
    return count;
}

function notFoundHint(text: string, edit: EditSpec): string {
    let message =
        'oldString was not found. It must match the file exactly, including whitespace, indentation and line breaks; read the file again and copy the current text.';
    const firstLine = edit.oldString
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '');
    if (firstLine !== undefined) {
        const index = text.split('\n').findIndex((line) => line.trim() === firstLine);
        if (index >= 0) {
            message += ` Its first line appears at line ${index + 1} (ignoring surrounding whitespace); compare the lines after it with the file.`;
        }
    }
    if (edit.newString.trim().length >= 8 && text.includes(edit.newString)) {
        message += ' newString already appears in the file; the change may have been made already.';
    }
    return message;
}

/**
 * Applies one exact-text replacement. Line endings need not match: in a CRLF file, `\n` in `oldString` and `newString`
 * stands for `\r\n`, so the file keeps its line endings. `$` in `newString` has no special meaning.
 */
export function applyEdit(text: string, edit: EditSpec): EditOutcome {
    if (edit.oldString === edit.newString) {
        return { ok: false, error: 'oldString and newString are identical; there is nothing to change.' };
    }
    if (edit.oldString === '') {
        return text === ''
            ? { ok: true, text: edit.newString, replacements: 1, index: 0 }
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
        return { ok: true, text: result, replacements: edit.replaceAll === true ? count : 1, index };
    }
    return { ok: false, error: notFoundHint(text, edit) };
}

/** Applies edits in order, each to the result of the previous one; stops at the first that fails. */
export function applyEdits(
    text: string,
    edits: readonly EditSpec[],
): { readonly ok: true; readonly text: string; readonly index: number } | { ok: false; error: string; edit: number } {
    let current = text;
    let first = Number.POSITIVE_INFINITY;
    for (const [number, edit] of edits.entries()) {
        const outcome = applyEdit(current, edit);
        if (!outcome.ok) {
            return { ok: false, error: outcome.error, edit: number };
        }
        current = outcome.text;
        first = Math.min(first, outcome.index);
    }
    return { ok: true, text: current, index: Number.isFinite(first) ? first : 0 };
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

async function save(file: string, shown: string, text: string, encoding: TextEncoding): Promise<ToolResult | null> {
    try {
        await writeFileAtomic(file, encodeText(text, encoding));
        return null;
    } catch (error) {
        return errorResult(`Cannot write ${shown}: ${describeError(error)}`);
    }
}

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
    const before = existing.state === 'text' ? existing.file.text : '';
    const outcome = applyEdit(before, input);
    if (!outcome.ok) {
        return errorResult(`Cannot edit ${shown}: ${outcome.error}`);
    }
    const after = keepFinalNewline(before, outcome.text);
    const failed = await save(file, shown, after, existing.state === 'text' ? existing.file.encoding : 'utf8');
    if (failed !== null) {
        return failed;
    }
    const view = snippet(after, outcome.index, input.newString);
    const what =
        existing.state === 'missing'
            ? `Created ${shown}.`
            : `Edited ${shown}: ${outcome.replacements} ${outcome.replacements === 1 ? 'replacement' : 'replacements'}.`;
    return {
        content: `${what} Lines around the ${outcome.replacements > 1 ? 'first ' : ''}change now read:\n${view.text}`,
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
    const before = existing.state === 'text' ? existing.file.text : '';
    const outcome = applyEdits(before, input.edits);
    if (!outcome.ok) {
        return errorResult(
            `Edit ${outcome.edit + 1} of ${input.edits.length} failed: ${outcome.error} No changes were written to ${shown}.`,
        );
    }
    const after = keepFinalNewline(before, outcome.text);
    const failed = await save(file, shown, after, existing.state === 'text' ? existing.file.encoding : 'utf8');
    if (failed !== null) {
        return failed;
    }
    const count = input.edits.length;
    const line = after.slice(0, outcome.index).split('\n').length;
    return {
        content: `${existing.state === 'missing' ? 'Created' : 'Edited'} ${shown}: applied ${count} ${count === 1 ? 'edit' : 'edits'}.`,
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
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path)],
    title: (input) => `Edit ${input.path} (${input.edits.length} ${input.edits.length === 1 ? 'change' : 'changes'})`,
    run: runMultiEdit,
};
