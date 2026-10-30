import { stat } from 'node:fs/promises';
import { readTextFile, type TextFile } from '../text.ts';
import type { ToolResult } from '../types.ts';
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
