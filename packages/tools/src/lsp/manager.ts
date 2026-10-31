import path from 'node:path';
import { sanitizeEnv } from '../env.ts';
import { realpathLoose } from '../path.ts';
import { displayPath } from '../tools/shared.ts';
import { LspClient } from './client.ts';
import { type EditReport, formatEditNote } from './format.ts';
import {
    DEFAULT_SERVERS,
    findInstalledCommand,
    findProjectCommand,
    projectCodeIn,
    type ResolvedCommand,
    type ServerSpec,
    serverFor,
    serverRoot,
    workspaceRootOf,
} from './servers.ts';

/** Servers stop after this long without being asked anything. */
export const LSP_IDLE_MS = 10 * 60_000;
/** How long `initialize` may take. */
export const LSP_START_TIMEOUT_MS = 30_000;
/** How long a request may take; references in a large project are the slow case. */
export const LSP_REQUEST_TIMEOUT_MS = 30_000;
/** How long the `diagnostics` operation waits for a first report on a file, e.g. while a project loads. */
export const LSP_DIAGNOSTICS_TIMEOUT_MS = 15_000;
/** How long an edit waits for diagnostics before its result goes back without them. */
export const EDIT_DIAGNOSTICS_WAIT_MS = 1500;
/** A report followed by another this quickly is not the last word (syntax first, types later). */
export const DIAGNOSTICS_SETTLE_MS = 300;
/** Files of one edit that get diagnostics; the rest are only synced. */
const MAX_EDIT_FILES = 10;
/** A server that stops unexpectedly this often within the window is not restarted until the window has passed. */
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 5 * 60_000;
/** How long a PATH search is reused: most edits happen where no server is installed, and PATH rarely changes. */
const INSTALLED_CACHE_MS = 60_000;

export interface LspManagerOptions {
    /** The servers to use; defaults to `DEFAULT_SERVERS`. */
    readonly servers?: readonly ServerSpec[];
    /** Environment of the servers, and PATH to find them on; defaults to this process's, without secrets. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly clientInfo?: { readonly name: string; readonly version: string };
    readonly idleMs?: number;
    readonly startTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly diagnosticsTimeoutMs?: number;
    readonly editWaitMs?: number;
    readonly settleMs?: number;
    readonly log?: (message: string) => void;
}

export type ServerLookup =
    | { readonly kind: 'ok'; readonly client: LspClient; readonly spec: ServerSpec; readonly languageId: string }
    /** No server handles files of this type. */
    | { readonly kind: 'unsupported' }
    /** The file is not inside any of the roots. */
    | { readonly kind: 'outside' }
    /** A server handles the file but cannot run; `reason` says why, for the model. */
    | { readonly kind: 'unavailable'; readonly spec: ServerSpec; readonly reason: string };

/** A file an edit tool changed. */
export interface EditedFile {
    readonly path: string;
    /** The new content; `null` when the file was deleted. */
    readonly text: string | null;
    /** The file was moved here from this path. */
    readonly movedFrom?: string | undefined;
}

export interface EditDiagnosticsOptions {
    /** Roots of the session, real paths. */
    readonly roots: readonly string[];
    readonly trusted: boolean;
    /** Working directory, for showing paths. */
    readonly cwd: string;
    readonly signal?: AbortSignal | undefined;
}

function sleepUntil(deadline: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/** Whether the server is ready before `deadline`. */
export async function readyBy(client: LspClient, deadline: number, signal?: AbortSignal): Promise<boolean> {
    return Promise.race([
        client.ready.then(
            () => true,
            () => false,
        ),
        sleepUntil(deadline, signal).then(() => false),
    ]);
}

/**
 * Language servers of one engine process (04 §3). A server starts on first use for a (server, root) pair, is shared
 * by every session working in that root, stops after `idleMs` without use, and is restarted on the next use if it
 * crashed, unless it keeps crashing. Servers that come from the project or would load code from it only run when the
 * project is trusted.
 */
export class LspManager {
    readonly #servers: readonly ServerSpec[];
    readonly #env: Readonly<Record<string, string | undefined>>;
    readonly #serverEnv: Readonly<Record<string, string>>;
    readonly #clientInfo: { readonly name: string; readonly version: string };
    readonly #idleMs: number;
    readonly startTimeoutMs: number;
    readonly #log: (message: string) => void;
    readonly #clients = new Map<string, LspClient>();
    readonly #idle = new Map<LspClient, ReturnType<typeof setTimeout>>();
    readonly #crashes = new Map<string, { times: number[]; last: string }>();
    readonly #installed = new Map<string, { readonly at: number; readonly found: ResolvedCommand | undefined }>();
    readonly requestTimeoutMs: number;
    readonly diagnosticsTimeoutMs: number;
    readonly editWaitMs: number;
    readonly settleMs: number;

    constructor(options: LspManagerOptions = {}) {
        this.#servers = options.servers ?? DEFAULT_SERVERS;
        this.#env = options.env ?? process.env;
        this.#serverEnv = sanitizeEnv(this.#env);
        this.#clientInfo = options.clientInfo ?? { name: 'xora', version: '1' };
        this.#idleMs = options.idleMs ?? LSP_IDLE_MS;
        this.startTimeoutMs = options.startTimeoutMs ?? LSP_START_TIMEOUT_MS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS;
        this.diagnosticsTimeoutMs = options.diagnosticsTimeoutMs ?? LSP_DIAGNOSTICS_TIMEOUT_MS;
        this.editWaitMs = options.editWaitMs ?? EDIT_DIAGNOSTICS_WAIT_MS;
        this.settleMs = options.settleMs ?? DIAGNOSTICS_SETTLE_MS;
        this.#log = options.log ?? (() => undefined);
    }

    get servers(): readonly ServerSpec[] {
        return this.#servers;
    }

    /** Servers that are starting or running. */
    running(): LspClient[] {
        return [...this.#clients.values()];
    }

    /**
     * The server for `file`, started if needed (`ready` tells when it is up). `roots` are the session's roots as real
     * paths; `file` must be a real path too.
     */
    async lookup(file: string, roots: readonly string[], trusted: boolean): Promise<ServerLookup> {
        const match = serverFor(this.#servers, file);
        if (!match) {
            return { kind: 'unsupported' };
        }
        // `file` is a real path: compare it with real roots (Windows 8.3 names, macOS /var → /private/var).
        const realRoots = await Promise.all(
            roots.map((root) => realpathLoose(path.resolve(root)).catch(() => path.resolve(root))),
        );
        const workspace = workspaceRootOf(file, realRoots);
        if (workspace === undefined) {
            return { kind: 'outside' };
        }
        const { spec, languageId } = match;
        const root = await serverRoot(spec, file, workspace);
        const key = `${spec.id}\u0000${root}\u0000${trusted ? 'trusted' : 'untrusted'}`;
        const running = this.#live(key);
        if (running) {
            return { kind: 'ok', client: running, spec, languageId };
        }
        if (!trusted && spec.projectCode !== undefined) {
            const found = await projectCodeIn(spec, file, workspace);
            if (found !== undefined) {
                return {
                    kind: 'unavailable',
                    spec,
                    reason: `${spec.name} would load ${displayPath(workspace, found)} from the project, which runs code from the repository, and this project is not trusted. Trusting the project (Settings → Extensions) enables the language server.`,
                };
            }
        }
        const crashed = this.#crashes.get(key);
        const recent = crashed?.times.filter((time) => Date.now() - time < CRASH_WINDOW_MS) ?? [];
        if (crashed && recent.length >= MAX_CRASHES) {
            return {
                kind: 'unavailable',
                spec,
                reason: `${spec.name} stopped unexpectedly ${recent.length} times in the last few minutes, so it is not restarted for now. The last failure: ${crashed.last}`,
            };
        }
        const command =
            (trusted ? await findProjectCommand(spec, file, workspace, this.#env) : undefined) ??
            (await this.#findInstalled(spec));
        if (!command) {
            return { kind: 'unavailable', spec, reason: await this.#missing(spec, file, workspace, trusted) };
        }
        // Another lookup may have started it while this one was searching.
        const raced = this.#live(key);
        if (raced) {
            return { kind: 'ok', client: raced, spec, languageId };
        }
        const client = new LspClient({
            spec,
            root,
            command: command.path,
            args: command.args,
            env: this.#serverEnv,
            trusted,
            clientInfo: this.#clientInfo,
            startTimeoutMs: this.startTimeoutMs,
        });
        this.#clients.set(key, client);
        this.#log(`lsp: starting ${spec.name} (${command.path}) in ${root}`);
        let counted = false;
        const crash = (reason: string): void => {
            if (!counted) {
                counted = true;
                const entry = this.#crashes.get(key) ?? { times: [], last: '' };
                entry.times = [...entry.times.filter((time) => Date.now() - time < CRASH_WINDOW_MS), Date.now()];
                entry.last = reason;
                this.#crashes.set(key, entry);
                // The executable may be gone or broken; look again next time.
                this.#installed.delete(spec.id);
            }
        };
        client.onClose = (closed, expected) => {
            if (this.#clients.get(key) === closed) {
                this.#clients.delete(key);
            }
            clearTimeout(this.#idle.get(closed));
            this.#idle.delete(closed);
            if (!expected) {
                crash(closed.failure);
                this.#log(`lsp: ${closed.failure}`);
            }
        };
        client.ready.catch(() => crash(client.failure));
        this.#armIdle(client, this.#idleMs);
        return { kind: 'ok', client, spec, languageId };
    }

    /**
     * Brings the servers up to date after an edit tool changed files, and returns a note on the errors the edit
     * introduced, for the tool result. Waits at most `editWaitMs` in all; a server still starting gets the files once
     * it is up and contributes nothing this time.
     */
    async diagnosticsAfterEdit(
        changes: readonly EditedFile[],
        options: EditDiagnosticsOptions,
    ): Promise<string | undefined> {
        const deadline = Date.now() + this.editWaitMs;
        const gone: string[] = [];
        const written: Array<{ file: string; text: string }> = [];
        for (const change of changes) {
            const file = await realpathLoose(change.path).catch(() => path.resolve(change.path));
            if (change.movedFrom !== undefined) {
                gone.push(await realpathLoose(change.movedFrom).catch(() => path.resolve(change.movedFrom ?? '')));
            }
            if (change.text === null) {
                gone.push(file);
            } else {
                written.push({ file, text: change.text });
            }
        }
        for (const client of this.#clients.values()) {
            if (client.state !== 'ready') {
                continue;
            }
            for (const file of gone) {
                client.closeDocument(file);
            }
            // Servers that do not watch files themselves (gopls) learn about the changes this way.
            client.filesChanged([
                ...gone.map((file) => ({ file, type: 3 as const })),
                ...written.map(({ file }) => ({ file, type: 2 as const })),
            ]);
        }
        const reports = await Promise.all(
            written.slice(0, MAX_EDIT_FILES).map((change) => this.#afterEdit(change, deadline, options)),
        );
        // The reports name real paths: relative to the real working directory, they read as the agent wrote them.
        return formatEditNote(
            await realpathLoose(options.cwd).catch(() => path.resolve(options.cwd)),
            reports.filter((report): report is EditReport => report !== undefined),
        );
    }

    /** Stops every server; used when the engine shuts down and by tests. */
    async shutdownAll(): Promise<void> {
        const clients = [...this.#clients.values()];
        this.#clients.clear();
        for (const timer of this.#idle.values()) {
            clearTimeout(timer);
        }
        this.#idle.clear();
        await Promise.all(clients.map((client) => client.shutdown()));
    }

    async #afterEdit(
        change: { readonly file: string; readonly text: string },
        deadline: number,
        options: EditDiagnosticsOptions,
    ): Promise<EditReport | undefined> {
        const found = await this.lookup(change.file, options.roots, options.trusted);
        if (found.kind !== 'ok') {
            return undefined;
        }
        const { client, spec, languageId } = found;
        if (!(await readyBy(client, deadline, options.signal))) {
            // Open the file once the server is up, so that the next question about it is answered quickly.
            client.ready
                .then(() => {
                    client.syncDocument(change.file, change.text, languageId);
                })
                .catch(() => undefined);
            return undefined;
        }
        if (client.state !== 'ready') {
            return undefined;
        }
        // What the server said about the text before the edit, if it had seen it: the baseline for "new".
        const before = client.currentReport(change.file)?.items;
        const { changed } = client.syncDocument(change.file, change.text, languageId);
        const report = await client.waitForCurrent(change.file, {
            deadline,
            settleMs: this.settleMs,
            signal: options.signal,
        });
        if (!report) {
            return undefined;
        }
        return { file: change.file, server: spec.name, before: changed ? before : report.items, after: report.items };
    }

    async #missing(spec: ServerSpec, file: string, workspace: string, trusted: boolean): Promise<string> {
        let text = `No ${spec.language} language server was found: install ${spec.name} (${spec.install}) so that it is on PATH`;
        if (spec.nodeModules === true && !trusted) {
            const inProject = await findProjectCommand(spec, file, workspace, this.#env);
            if (inProject !== undefined) {
                return `${text}. The project has one in ${displayPath(workspace, inProject.path)}, but servers from the project only run once the project is trusted (Settings → Extensions).`;
            }
        }
        if (spec.nodeModules === true) {
            text += ", or add it to the project's devDependencies";
        }
        return `${text}.`;
    }

    async #findInstalled(spec: ServerSpec): Promise<ResolvedCommand | undefined> {
        const cached = this.#installed.get(spec.id);
        if (cached !== undefined && Date.now() - cached.at < INSTALLED_CACHE_MS) {
            return cached.found;
        }
        const found = await findInstalledCommand(spec, this.#env);
        this.#installed.set(spec.id, { at: Date.now(), found });
        return found;
    }

    #live(key: string): LspClient | undefined {
        const client = this.#clients.get(key);
        return client && client.state !== 'closed' ? client : undefined;
    }

    #armIdle(client: LspClient, delay: number): void {
        clearTimeout(this.#idle.get(client));
        const timer = setTimeout(() => {
            this.#idle.delete(client);
            if (client.state === 'closed') {
                return;
            }
            const idleFor = Date.now() - client.lastUsed;
            if (client.busy || idleFor < this.#idleMs) {
                this.#armIdle(client, client.busy ? this.#idleMs : this.#idleMs - idleFor);
                return;
            }
            this.#log(`lsp: stopping ${client.spec.name} in ${client.root} after ${Math.round(idleFor / 1000)}s idle`);
            void client.shutdown();
        }, delay);
        timer.unref();
        this.#idle.set(client, timer);
    }
}
