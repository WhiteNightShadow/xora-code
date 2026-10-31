import path from 'node:path';
import { displayPath } from '../tools/shared.ts';
import { truncateLine } from '../truncate.ts';
import {
    type Diagnostic,
    DiagnosticSeverity,
    type DocumentSymbol,
    type Hover,
    type MarkedString,
    type Range,
    type SymbolInformation,
    severityName,
    symbolKindName,
} from './protocol.ts';

/** How language server answers read to the model: paths relative to the working directory, 1-based positions. */

const MESSAGE_MAX_CHARS = 400;

/** `12:5` for a 0-based protocol position. */
/** Starts the note an edit's tool result gets when language servers report new problems. */
export const LSP_EDIT_NOTE = 'LSP diagnostics after the edit:';

export function position(range: Range): string {
    return `${range.start.line + 1}:${range.start.character + 1}`;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Errors first, then by position. */
function byImportance(a: Diagnostic, b: Diagnostic): number {
    return (
        (a.severity ?? 1) - (b.severity ?? 1) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character
    );
}

/**
 * `12:5 error TS2322: Type 'string' is not assignable to type 'number'.` Further lines of a message (notes, as clangd
 * and rustc write them) are indented below, without blank lines, and paths in the working directory are shortened.
 */
export function diagnosticLine(diagnostic: Diagnostic, cwd?: string): string {
    const code = diagnostic.code === undefined || diagnostic.code === '' ? '' : ` ${diagnostic.code}`;
    let text = diagnostic.message;
    if (cwd !== undefined) {
        text = text.replaceAll(`${cwd}${path.sep}`, '');
    }
    const message = truncateLine(text.trim(), MESSAGE_MAX_CHARS)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join('\n    ');
    return `${position(diagnostic.range)} ${severityName(diagnostic.severity)}${code}: ${message}`;
}

function countBySeverity(items: readonly Diagnostic[]): { errors: number; warnings: number; infos: number } {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const item of items) {
        const severity = item.severity ?? DiagnosticSeverity.Error;
        if (severity === DiagnosticSeverity.Error) {
            errors++;
        } else if (severity === DiagnosticSeverity.Warning) {
            warnings++;
        } else if (severity === DiagnosticSeverity.Information) {
            infos++;
        }
    }
    return { errors, warnings, infos };
}

/** `2 errors, 1 warning`, or `no problems`; hints are left out, they are suggestions rather than problems. */
function summary(items: readonly Diagnostic[], adjective = ''): string {
    const { errors, warnings, infos } = countBySeverity(items);
    const parts = [
        errors > 0 ? plural(errors, `${adjective}error`) : '',
        warnings > 0 ? plural(warnings, `${adjective}warning`) : '',
        infos > 0 ? `${infos} ${adjective}${infos === 1 ? 'note' : 'notes'}` : '',
    ].filter((part) => part !== '');
    return parts.length > 0 ? parts.join(', ') : 'no problems';
}

/** Per file in the `diagnostics` operation: errors, warnings and notes, at most `limit` lines. */
export function formatFileDiagnostics(
    cwd: string,
    file: string,
    items: readonly Diagnostic[],
    server: string,
    limit: number,
): string {
    const shown = items
        .filter((item) => (item.severity ?? DiagnosticSeverity.Error) !== DiagnosticSeverity.Hint)
        .sort(byImportance);
    const lines = [`${displayPath(cwd, file)}: ${summary(shown)} (${server})`];
    for (const item of shown.slice(0, limit)) {
        lines.push(`  ${diagnosticLine(item, cwd)}`);
    }
    if (shown.length > limit) {
        lines.push(`  … ${shown.length - limit} more not shown`);
    }
    return lines.join('\n');
}

/** What one server reported on one edited file, before and after the edit. */
export interface EditReport {
    readonly file: string;
    readonly server: string;
    /** Diagnostics for the content before the edit, when the server had reported on it. */
    readonly before: readonly Diagnostic[] | undefined;
    readonly after: readonly Diagnostic[];
}

const diagnosticKey = (item: Diagnostic): string =>
    `${item.severity ?? 1}\u0000${String(item.code ?? '')}\u0000${item.source ?? ''}\u0000${item.message}`;

/**
 * Diagnostics in `after` that `before` does not have. Positions are ignored, since an edit moves the lines below it;
 * equal problems are matched one to one.
 */
export function newDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
    const counts = new Map<string, number>();
    for (const item of before) {
        const key = diagnosticKey(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return after.filter((item) => {
        const key = diagnosticKey(item);
        const left = counts.get(key) ?? 0;
        if (left > 0) {
            counts.set(key, left - 1);
            return false;
        }
        return true;
    });
}

export interface EditNoteLimits {
    readonly errorsPerFile: number;
    readonly errors: number;
    readonly warnings: number;
}

export const EDIT_NOTE_LIMITS: EditNoteLimits = { errorsPerFile: 10, errors: 20, warnings: 5 };

/**
 * The note appended to the result of an edit: errors the edit introduced (all errors when the server had not seen
 * the file before) and a few warnings, so the model notices breakage without running a build. Nothing when there is
 * nothing new to say.
 */
export function formatEditNote(
    cwd: string,
    reports: readonly EditReport[],
    limits: EditNoteLimits = EDIT_NOTE_LIMITS,
): string | undefined {
    const blocks: string[] = [];
    let errorBudget = limits.errors;
    let warningBudget = limits.warnings;
    for (const report of reports) {
        const fresh = (report.before === undefined ? [...report.after] : newDiagnostics(report.before, report.after))
            .filter((item) => (item.severity ?? DiagnosticSeverity.Error) <= DiagnosticSeverity.Warning)
            .sort(byImportance);
        const errors = fresh.filter((item) => (item.severity ?? DiagnosticSeverity.Error) === DiagnosticSeverity.Error);
        const warnings = fresh.filter((item) => item.severity === DiagnosticSeverity.Warning);
        const shown = displayPath(cwd, report.file);
        const remaining = countBySeverity(report.after).errors;
        if (fresh.length === 0) {
            // Worth saying only while errors are being fixed: how many are left.
            const hadErrors = report.before !== undefined && countBySeverity(report.before).errors > 0;
            if (hadErrors) {
                blocks.push(
                    remaining === 0
                        ? `${shown}: no errors left (${report.server})`
                        : `${shown}: no new errors, ${plural(remaining, 'error')} left (${report.server})`,
                );
            }
            continue;
        }
        const adjective = report.before === undefined ? '' : 'new ';
        const lines = [`${shown}: ${summary(fresh, adjective)} (${report.server})`];
        const showErrors = errors.slice(0, Math.max(0, Math.min(limits.errorsPerFile, errorBudget)));
        const showWarnings = warnings.slice(0, Math.max(0, warningBudget));
        errorBudget -= showErrors.length;
        warningBudget -= showWarnings.length;
        for (const item of [...showErrors, ...showWarnings]) {
            lines.push(`  ${diagnosticLine(item, cwd)}`);
        }
        const hidden = fresh.length - showErrors.length - showWarnings.length;
        if (hidden > 0) {
            lines.push(`  … ${hidden} more not shown; use the lsp tool (diagnostics) to see all`);
        }
        const older = remaining - errors.length;
        if (report.before !== undefined && older > 0) {
            lines.push(`  (and ${plural(older, 'error')} from before the edit, not listed)`);
        }
        blocks.push(lines.join('\n'));
    }
    return blocks.length > 0 ? `${LSP_EDIT_NOTE}\n${blocks.join('\n')}` : undefined;
}

/** `src/a.ts:12:5: const x = foo(1);` with the source line when `preview` has it. */
export function locationLine(cwd: string, file: string, range: Range, preview: string | undefined): string {
    const where = `${displayPath(cwd, file)}:${position(range)}`;
    return preview === undefined || preview.trim() === '' ? where : `${where}: ${truncateLine(preview.trim(), 200)}`;
}

function markedText(value: MarkedString): string {
    if (typeof value === 'string') {
        return value;
    }
    return value.value.trim() === '' ? '' : `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

/** The text of a hover, Markdown as the server wrote it. */
export function hoverText(hover: Hover): string {
    const { contents } = hover;
    let parts: string[];
    if (Array.isArray(contents)) {
        parts = contents.map(markedText);
    } else if (typeof contents === 'object' && contents !== null && 'kind' in contents) {
        parts = [contents.value];
    } else {
        parts = [markedText(contents as MarkedString)];
    }
    return parts
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join('\n\n');
}

function lines(range: Range): string {
    const start = range.start.line + 1;
    const end = range.end.line + 1;
    return end > start ? `lines ${start}-${end}` : `line ${start}`;
}

/** An indented outline of a file's symbols, at most `limit` entries. */
export function formatDocumentSymbols(
    symbols: readonly (DocumentSymbol | SymbolInformation)[],
    limit: number,
): { readonly text: string; readonly count: number } {
    const out: string[] = [];
    let count = 0;
    const visit = (symbol: DocumentSymbol, depth: number): void => {
        count++;
        if (out.length < limit) {
            // Usually a signature or type, e.g. `func(a int) string`.
            const detail = symbol.detail?.trim()
                ? `: ${truncateLine(symbol.detail.trim().replace(/\s+/g, ' '), 120)}`
                : '';
            out.push(
                `${'  '.repeat(depth)}${symbolKindName(symbol.kind)} ${symbol.name}${detail} (${lines(symbol.range)})`,
            );
        }
        for (const child of symbol.children ?? []) {
            visit(child, depth + 1);
        }
    };
    for (const symbol of symbols) {
        if ('location' in symbol) {
            // The flat form: one level, with the container named.
            count++;
            if (out.length < limit) {
                const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
                const range = 'range' in symbol.location ? ` (${lines(symbol.location.range)})` : '';
                out.push(`${symbolKindName(symbol.kind)} ${symbol.name}${container}${range}`);
            }
        } else {
            visit(symbol, 0);
        }
    }
    return { text: out.join('\n'), count };
}

/** `function foo (in Bar): src/a.ts:12:5` per workspace symbol. */
export function workspaceSymbolLine(cwd: string, symbol: SymbolInformation, file: string | undefined): string {
    const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
    const where =
        file === undefined
            ? symbol.location.uri
            : 'range' in symbol.location
              ? `${displayPath(cwd, file)}:${position(symbol.location.range)}`
              : displayPath(cwd, file);
    return `${symbolKindName(symbol.kind)} ${symbol.name}${container}: ${where}`;
}
