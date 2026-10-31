import type { AnyTool, LspManager, ToolResult } from './deps.ts';
import type { EngineSession } from './session.ts';

/**
 * Diagnostics as context (08 §1): when an edit tool has changed files, the language servers for them (running, or
 * started now when one is installed) get the new text, and the errors they report as new go back to the model with
 * the tool result. Bounded by the manager's edit wait (about 1.5 s); a server that is slower adds nothing this time.
 */
export async function withEditDiagnostics(
    lsp: LspManager | undefined,
    session: EngineSession,
    tool: AnyTool,
    result: ToolResult,
    signal: AbortSignal,
): Promise<ToolResult> {
    if (
        !lsp ||
        !session.config.lsp.diagnostics ||
        result.isError ||
        tool.kind !== 'edit' ||
        result.display?.kind !== 'diff'
    ) {
        return result;
    }
    try {
        const note = await lsp.diagnosticsAfterEdit(
            result.display.diffs.map((diff) => ({
                path: diff.path,
                text: diff.deleted ? null : diff.newText,
                movedFrom: diff.movedFrom,
            })),
            { roots: session.roots, trusted: session.config.lsp.trusted, cwd: session.cwd, signal },
        );
        return note === undefined ? result : { ...result, content: `${result.content}\n\n${note}` };
    } catch {
        // The edit itself succeeded; diagnostics are an extra.
        return result;
    }
}
