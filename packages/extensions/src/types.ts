/** Where an extension comes from. Together with project and plugin trust it decides what may run (09 §5). */
export type ExtensionOrigin = 'project' | 'user' | 'plugin' | 'builtin';

/** A directory scanned for skills, slash commands or agent definitions. */
export interface ExtensionSource {
    readonly dir: string;
    readonly origin: ExtensionOrigin;
    /** Whether code shipped with the source (hooks, skill scripts, MCP servers) may run; see `effectiveTrust`. */
    readonly trusted: boolean;
    /** Set for plugin sources: names are namespaced as `<pluginName>:<name>`. */
    readonly pluginName?: string;
    /** Install directory of the plugin, substituted for `${CLAUDE_PLUGIN_ROOT}`. */
    readonly pluginRoot?: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** A problem found while reading extension files. An `error` means the item it names was skipped. */
export interface Diagnostic {
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly file?: string;
}
