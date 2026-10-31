/**
 * The small part of the Language Server Protocol (3.17) that Xora uses, as plain types. Positions are 0-based, with
 * the character counted in UTF-16 code units (the protocol default, and what JavaScript string indices count).
 */

export interface Position {
    readonly line: number;
    readonly character: number;
}

export interface Range {
    readonly start: Position;
    readonly end: Position;
}

export interface Location {
    readonly uri: string;
    readonly range: Range;
}

export interface LocationLink {
    readonly originSelectionRange?: Range;
    readonly targetUri: string;
    readonly targetRange: Range;
    readonly targetSelectionRange: Range;
}

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const;

export interface Diagnostic {
    readonly range: Range;
    readonly severity?: number;
    readonly code?: number | string;
    readonly source?: string;
    readonly message: string;
}

export interface PublishDiagnosticsParams {
    readonly uri: string;
    readonly version?: number;
    readonly diagnostics: readonly Diagnostic[];
}

export interface DocumentSymbol {
    readonly name: string;
    readonly detail?: string;
    readonly kind: number;
    readonly range: Range;
    readonly selectionRange: Range;
    readonly children?: readonly DocumentSymbol[];
}

export interface SymbolInformation {
    readonly name: string;
    readonly kind: number;
    readonly location: Location | { readonly uri: string };
    readonly containerName?: string;
}

export interface MarkupContent {
    readonly kind: string;
    readonly value: string;
}

export type MarkedString = string | { readonly language: string; readonly value: string };

export interface Hover {
    readonly contents: MarkupContent | MarkedString | readonly MarkedString[];
    readonly range?: Range;
}

/** The server capabilities Xora looks at. */
export interface ServerCapabilities {
    readonly definitionProvider?: unknown;
    readonly referencesProvider?: unknown;
    readonly hoverProvider?: unknown;
    readonly documentSymbolProvider?: unknown;
    readonly workspaceSymbolProvider?: unknown;
}

/** `SymbolKind` names, indexed by the protocol's numbers (1-based). */
const SYMBOL_KINDS = [
    'symbol',
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enum member',
    'struct',
    'event',
    'operator',
    'type parameter',
];

export function symbolKindName(kind: number): string {
    return SYMBOL_KINDS[kind] ?? 'symbol';
}

/** Every kind, for the client capabilities: servers only send kinds the client says it knows. */
export const ALL_SYMBOL_KINDS: readonly number[] = SYMBOL_KINDS.map((_, index) => index).slice(1);

export function severityName(severity: number | undefined): string {
    switch (severity) {
        case DiagnosticSeverity.Warning:
            return 'warning';
        case DiagnosticSeverity.Information:
            return 'info';
        case DiagnosticSeverity.Hint:
            return 'hint';
        default:
            // The protocol leaves a missing severity to the client; errors are the safe reading.
            return 'error';
    }
}
