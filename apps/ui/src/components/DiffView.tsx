import { structuredPatch } from 'diff';
import { useMemo } from 'react';

interface Row {
    readonly kind: 'context' | 'add' | 'del' | 'hunk';
    readonly text: string;
    readonly oldLine?: number;
    readonly newLine?: number;
}

function rows(oldText: string, newText: string, context: number): Row[] {
    const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context });
    const result: Row[] = [];
    for (const hunk of patch.hunks) {
        result.push({
            kind: 'hunk',
            text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        });
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const line of hunk.lines) {
            const marker = line[0];
            const text = line.slice(1);
            if (marker === '+') {
                result.push({ kind: 'add', text, newLine: newLine++ });
            } else if (marker === '-') {
                result.push({ kind: 'del', text, oldLine: oldLine++ });
            } else if (marker === '\\') {
            } else {
                result.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
            }
        }
    }
    return result;
}

/** Unified diff with line numbers. Large files are diffed lazily per render of the selected file only. */
export function DiffView({
    oldText,
    newText,
    context = 3,
}: {
    oldText: string | null;
    newText: string | null;
    context?: number;
}) {
    const lines = useMemo(() => rows(oldText ?? '', newText ?? '', context), [oldText, newText, context]);
    if (lines.length === 0) {
        return <div className="diff diff--empty">无差异</div>;
    }
    return (
        <div className="diff">
            {lines.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional and re-render as a whole
                <div key={`${index}-${row.kind}`} className={`diff__row diff__row--${row.kind}`}>
                    <span className="diff__num">{row.oldLine ?? ''}</span>
                    <span className="diff__num">{row.newLine ?? ''}</span>
                    <span className="diff__marker">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
                    <span className="diff__text">{row.text || ' '}</span>
                </div>
            ))}
        </div>
    );
}

export function countChanges(oldText: string | null, newText: string): { additions: number; deletions: number } {
    const patch = structuredPatch('a', 'b', oldText ?? '', newText, '', '', { context: 0 });
    let additions = 0;
    let deletions = 0;
    for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
            if (line.startsWith('+')) additions++;
            else if (line.startsWith('-')) deletions++;
        }
    }
    return { additions, deletions };
}
