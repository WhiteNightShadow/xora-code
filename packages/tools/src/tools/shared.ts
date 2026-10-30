import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ToolResult } from '../types.ts';

/** How tools show a path to the model: relative to the working directory when inside it, with `/` separators. */
export function displayPath(cwd: string, file: string): string {
    const relative = path.relative(cwd, file);
    if (relative === '') {
        return '.';
    }
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return file;
    }
    return path.sep === '\\' ? relative.replaceAll('\\', '/') : relative;
}

/** A displayed path as a place in a sentence: `.` reads as "the working directory". */
export function placeName(shown: string): string {
    return shown === '.' ? 'the working directory' : shown;
}

export function errorResult(content: string): ToolResult {
    return { content, isError: true };
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
    ENOENT: 'no such file or directory',
    EACCES: 'permission denied',
    EPERM: 'operation not permitted',
    EISDIR: 'is a directory',
    ENOTDIR: 'a parent of the path is not a directory',
    EBUSY: 'the file is busy or locked',
    ENOSPC: 'no space left on the device',
    EROFS: 'the file system is read-only',
    ENAMETOOLONG: 'the path is too long',
    ELOOP: 'too many levels of symbolic links',
};

/** A short description of a file system error for the model. */
export function describeError(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== undefined && ERROR_TEXT[code] !== undefined) {
        return ERROR_TEXT[code];
    }
    return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** `File not found: x`, plus names from the same directory that differ only in case or extension, if any. */
export async function notFoundMessage(file: string, shown: string): Promise<string> {
    const wanted = path.basename(file);
    const stemOf = (name: string): string => name.toLowerCase().replace(/(.)\.[^.]*$/, '$1');
    let similar: string[] = [];
    try {
        similar = (await readdir(path.dirname(file)))
            .filter((name) => name !== wanted && stemOf(name) === stemOf(wanted))
            .slice(0, 5);
    } catch {
        // The directory does not exist either.
    }
    return similar.length > 0
        ? `File not found: ${shown} (did you mean ${similar.join(', ')}?)`
        : `File not found: ${shown}`;
}

/** Formats one line like `cat -n`: the 1-based number right-aligned in six columns, a tab, the text. */
export function numberedLine(lineNumber: number, text: string): string {
    return `${String(lineNumber).padStart(6)}\t${text}`;
}
