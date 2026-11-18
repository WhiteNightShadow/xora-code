import { stat } from 'node:fs/promises';
import { realpathLoose } from '../path.ts';
import { readTextFile, type TextFile } from '../text.ts';
import type { ToolContext, ToolResult } from '../types.ts';
import { describeError, errorCode, errorResult } from './shared.ts';

/** The current state of a file a tool is about to change. */
export type ExistingFile =
    | { readonly state: 'missing' }
    | { readonly state: 'text'; readonly file: TextFile }
    | { readonly state: 'binary' };

/** Reads the file at `file` for an edit; directories and unreadable files come back as an error result. */
export async function loadExisting(file: string, shown: string): Promise<ExistingFile | ToolResult> {
    try {
        const stats = await stat(file);
        if (stats.isDirectory()) {
            return errorResult(`${shown} is a directory, not a file.`);
        }
        const text = await readTextFile(file);
        return text === null ? { state: 'binary' } : { state: 'text', file: text };
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return { state: 'missing' };
        }
        return errorResult(`Cannot read ${shown}: ${describeError(error)}`);
    }
}

export function isToolResult(value: ExistingFile | ToolResult): value is ToolResult {
    return 'content' in value;
}

/**
 * Why a file whose bytes are text in no encoding known here is not rewritten (see `TextFile.lossy`): its text as
 * read has lost those bytes, and saving it would lose them in the file.
 */
export function lossyMessage(shown: string): string {
    return `${shown} is not valid UTF-8, UTF-16 or GB18030 text, so rewriting it from here would damage the bytes that could not be decoded. Convert it to UTF-8 first (iconv, for example), or change it with a script that works on its bytes.`;
}

/** Records `file` as the session sees it now: after reading it, and after writing it. */
export async function noteSeen(ctx: Pick<ToolContext, 'files'>, file: string): Promise<void> {
    if (!ctx.files) {
        return;
    }
    try {
        const real = await realpathLoose(file);
        const stats = await stat(real);
        ctx.files.note(real, { mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
        // Gone again: nothing to remember.
    }
}

/** See {@link seenState}. */
export type SeenState = 'unseen' | 'changed' | 'current';

/**
 * Records a file a tool has just changed in part. The session knows what is in it now only when it knew before: an
 * edit shows the model the few lines it changed, so a file it never read, or one someone else has written since it
 * did, stays that, and `write` goes on refusing to replace it. `before`: how the file stood before the change
 * ({@link seenState}), or `created` when the tool wrote all there is of it.
 */
export async function noteChanged(
    ctx: Pick<ToolContext, 'files'>,
    file: string,
    before: SeenState | 'created' | undefined,
): Promise<void> {
    if (before === 'current' || before === 'created') {
        await noteSeen(ctx, file);
    }
}

/**
 * How the file on disk stands to what the session saw of it: `unseen` when it never read or wrote it, `changed`
 * when someone else has written it since (the user, another agent, a formatter). Nothing without a ledger.
 */
export async function seenState(ctx: Pick<ToolContext, 'files'>, file: string): Promise<SeenState | undefined> {
    if (!ctx.files) {
        return undefined;
    }
    try {
        const real = await realpathLoose(file);
        const seen = ctx.files.seen(real);
        if (!seen) {
            return 'unseen';
        }
        const stats = await stat(real);
        return stats.mtimeMs === seen.mtimeMs && stats.size === seen.size ? 'current' : 'changed';
    } catch {
        return undefined;
    }
}
