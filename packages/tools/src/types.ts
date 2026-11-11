import type { z } from 'zod';
import type { LspManager } from './lsp/manager.ts';

/**
 * Contract between the xora engine and its built-in tools. Tools only do the work; whether a call may run is
 * decided before `run` by the engine and the host, using `kind`, `readOnly` and `targets`.
 */

/** Mirrors ACP's `ToolKind`, which the UI uses to pick icons and wording. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export interface TodoItem {
    readonly content: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
    readonly priority?: 'high' | 'medium' | 'low';
}

/** Where large outputs go; the model gets an excerpt plus an id it can read back with the `read` tool. */
export interface ArtifactSink {
    /** Stores `content` and returns an absolute file path the `read` tool accepts. */
    save(name: string, content: string): Promise<string>;
}

export interface BackgroundJob {
    readonly id: string;
    readonly command: string;
    readonly startedAt: number;
    readonly exitCode: number | null;
    readonly running: boolean;
    /** Output so far, possibly truncated at the front. */
    output(): string;
    kill(): void;
}

/** Language servers as one session may use them (the `lsp` tool). */
export interface LspAccess {
    /** Shared by the sessions of an engine process. */
    readonly manager: LspManager;
    /**
     * Whether the project is trusted: only then do servers come from its `node_modules/.bin`, and servers that would
     * load code from the project start at all.
     */
    readonly trusted: boolean;
}

/** Background shell jobs started by `bash` with `background: true`, scoped to one session. */
export interface JobRegistry {
    add(job: BackgroundJob): void;
    get(id: string): BackgroundJob | undefined;
    list(): readonly BackgroundJob[];
}

export interface ToolContext {
    /** Working directory of the session: an absolute, real path. */
    readonly cwd: string;
    /** Absolute real paths the session may touch. Always contains `cwd`. */
    readonly roots: readonly string[];
    readonly signal: AbortSignal;
    /** Environment for child processes, already stripped of secrets by the caller. */
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly artifacts: ArtifactSink;
    readonly jobs: JobRegistry;
    /** Session todo list read and written by the `todo` tool. */
    readonly todos: { get(): readonly TodoItem[]; set(items: readonly TodoItem[]): void };
    /**
     * Earlier tool output kept in the session though the context only shows a reference to it (`#R12`), for the
     * `tool_output` tool (20 §4.3).
     */
    readonly outputs?: { read(ref: string): { readonly tool: string; readonly text: string } | undefined };
    /** Streams live output of long-running tools such as `bash`. */
    readonly onOutput?: (chunk: string) => void;
    /** Shell used by `bash`. Defaults to `$SHELL` or `/bin/bash` on unix and `powershell.exe` on windows. */
    readonly shell?: string;
    /** Language servers for `lsp`; without them the tool says they are not available. */
    readonly lsp?: LspAccess;
}

export interface FileDiff {
    readonly path: string;
    /** `null` when the file did not exist before. */
    readonly oldText: string | null;
    readonly newText: string;
    /** The file was deleted; `newText` is then empty. */
    readonly deleted?: boolean;
    /** The file was moved here from this path; `oldText` is the content it had there. */
    readonly movedFrom?: string;
}

/** Structured result for the UI; the model only sees `content`. */
export type ToolDisplay =
    | { readonly kind: 'diff'; readonly diffs: readonly FileDiff[] }
    | {
          readonly kind: 'command';
          readonly command: string;
          readonly exitCode: number | null;
          readonly output: string;
          readonly truncated: boolean;
          readonly artifactPath?: string;
          readonly durationMs: number;
          readonly background?: { readonly jobId: string };
      }
    | { readonly kind: 'files'; readonly paths: readonly string[]; readonly truncated: boolean }
    | { readonly kind: 'matches'; readonly count: number; readonly files: number; readonly truncated: boolean }
    | {
          readonly kind: 'read';
          readonly path: string;
          readonly startLine: number;
          readonly endLine: number;
          readonly totalLines: number;
      }
    | { readonly kind: 'todo'; readonly items: readonly TodoItem[] }
    | { readonly kind: 'text'; readonly text: string };

export interface ToolLocation {
    readonly path: string;
    readonly line?: number;
}

export interface ToolResult {
    /** Text returned to the model. */
    readonly content: string;
    readonly isError?: boolean;
    readonly display?: ToolDisplay;
    readonly locations?: readonly ToolLocation[];
}

export interface ToolDefinition<Input = unknown> {
    readonly name: string;
    readonly description: string;
    readonly kind: ToolKind;
    readonly schema: z.ZodType<Input>;
    /** Read-only calls may run in parallel and are allowed without asking in every permission mode. */
    readonly readOnly: boolean;
    /** Absolute paths the call will read or write, resolved against `ctx.cwd`, for path checks before `run`. */
    targets(input: Input, ctx: Pick<ToolContext, 'cwd'>): readonly string[];
    /** Short title for the UI, e.g. `Read src/index.ts`. */
    title(input: Input): string;
    run(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

/** Erases the input type so tools with different inputs fit in one list. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists need an erased input type
export type AnyTool = ToolDefinition<any>;
