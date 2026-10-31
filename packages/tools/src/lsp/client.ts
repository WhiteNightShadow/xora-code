import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    ConnectionClosedError,
    ErrorCodes,
    JsonRpcConnection,
    MessageReader,
    type RequestOptions,
    ResponseError,
} from './jsonrpc.ts';
import { hasExited, killTree, startServerProcess, waitForExit } from './process.ts';
import {
    ALL_SYMBOL_KINDS,
    type Diagnostic,
    type PublishDiagnosticsParams,
    type ServerCapabilities,
} from './protocol.ts';
import type { ServerSpec } from './servers.ts';

export function fileUri(file: string): string {
    return pathToFileURL(file).href;
}

/** The path of a `file:` URI; `undefined` for other schemes. */
export function uriToFile(uri: string): string | undefined {
    try {
        return fileURLToPath(uri);
    } catch {
        return undefined;
    }
}

/** Compares paths the way the file system does: servers spell Windows drives and URIs in their own ways. */
export function fileKey(file: string): string {
    const normal = path.normalize(file);
    return process.platform === 'win32' ? normal.toLowerCase() : normal;
}

/** What a server last published for a file. */
export interface DiagnosticsReport {
    readonly items: readonly Diagnostic[];
    /** Document version the report is for, when the server says. */
    readonly version: number | undefined;
    /** Arrival order among all reports of the server. */
    readonly seq: number;
    /** When it arrived. */
    readonly at: number;
}

interface OpenDocument {
    readonly uri: string;
    readonly languageId: string;
    version: number;
    text: string;
    /** `seq` of the newest report when the text was last sent; later reports describe this text. */
    syncedAt: number;
}

interface Waiter {
    check(): void;
    cancel(): void;
}

export interface LspClientOptions {
    readonly spec: ServerSpec;
    /** Workspace folder the server is started for; also its working directory. */
    readonly root: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly trusted: boolean;
    readonly clientInfo: { readonly name: string; readonly version: string };
    readonly startTimeoutMs: number;
}

/** Open documents per server; the least recently used is closed beyond this, so servers do not grow without end. */
const MAX_OPEN_DOCUMENTS = 64;
/** Reports kept per server; servers that check the whole workspace report on many files nobody asked about. */
const MAX_REPORTS = 2000;
const STDERR_LINES = 20;
/** `shutdown` gets this long before the process is told to exit and then signalled. */
const STOP_STEP_MS = 1500;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
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

/**
 * One language server process: the `initialize` handshake, open documents and their versions, diagnostics the
 * server publishes, requests, and an orderly or forced stop. Shared by every session working in its root.
 */
export class LspClient {
    readonly spec: ServerSpec;
    readonly root: string;
    readonly command: string;
    /** Settles when `initialize` has been answered; rejects when the server could not be started. */
    readonly ready: Promise<void>;
    /** Last time a session asked anything of this server. */
    lastUsed = Date.now();
    /** Called once when the process is gone; `expected` is false when it was not asked to stop. */
    onClose: ((client: LspClient, expected: boolean) => void) | undefined;

    readonly #options: LspClientOptions;
    readonly #connection: JsonRpcConnection;
    readonly #documents = new Map<string, OpenDocument>();
    readonly #reports = new Map<string, DiagnosticsReport>();
    readonly #waiters = new Set<Waiter>();
    readonly #stderr: string[] = [];
    #child: ChildProcess | undefined;
    #state: 'starting' | 'ready' | 'closed' = 'starting';
    #capabilities: ServerCapabilities = {};
    #seq = 0;
    #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    #failure: string | undefined;
    /** The output stream broke; nothing more is read from it. */
    #broken = false;
    #stopping = false;
    #closeReported = false;
    #closing: Promise<void> | undefined;

    constructor(options: LspClientOptions) {
        this.#options = options;
        this.spec = options.spec;
        this.root = options.root;
        this.command = options.command;
        this.#connection = new JsonRpcConnection((frame) => this.#child?.stdin?.write(frame), {
            onRequest: (method, params) => this.#onRequest(method, params),
            onNotification: (method, params) => this.#onNotification(method, params),
        });
        this.ready = this.#start();
        // Callers that never wait for it must not cause an unhandled rejection.
        this.ready.catch(() => undefined);
    }

    get state(): 'starting' | 'ready' | 'closed' {
        return this.#state;
    }

    get pid(): number | undefined {
        return this.#child?.pid;
    }

    get capabilities(): ServerCapabilities {
        return this.#capabilities;
    }

    /** Something is waiting on the server, so it should not be stopped for being idle. */
    get busy(): boolean {
        return this.#connection.pending > 0 || this.#waiters.size > 0;
    }

    /** Arrival number of the newest report; pass it to `waitForReport` to wait for a later one. */
    get reportSeq(): number {
        return this.#seq;
    }

    /** Why the server stopped or could not start, with the last lines of its stderr. */
    get failure(): string {
        return this.#failure ?? this.#exitText();
    }

    async request<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
        this.lastUsed = Date.now();
        try {
            return await this.#connection.request<T>(method, params, options);
        } catch (error) {
            if (!(error instanceof ResponseError) || error.code !== ErrorCodes.ContentModified) {
                throw error;
            }
            // Servers answer this while they load or reload the project; a second try usually gets an answer.
            await sleep(500, options.signal);
            return await this.#connection.request<T>(method, params, options);
        } finally {
            this.lastUsed = Date.now();
        }
    }

    isOpen(file: string): boolean {
        return this.#documents.has(fileKey(file));
    }

    /**
     * Sends `text` as the content of `file`: `didOpen` the first time, `didChange` (the whole text) when it differs
     * from what the server has. Only valid once `ready` has settled.
     */
    syncDocument(
        file: string,
        text: string,
        languageId: string,
    ): { readonly version: number; readonly changed: boolean } {
        if (this.#state !== 'ready') {
            throw new Error(`${this.spec.name} is not running`);
        }
        this.lastUsed = Date.now();
        const key = fileKey(file);
        const open = this.#documents.get(key);
        if (open) {
            this.#documents.delete(key);
            this.#documents.set(key, open);
            if (open.text === text) {
                return { version: open.version, changed: false };
            }
            open.version++;
            open.text = text;
            open.syncedAt = this.#seq;
            this.#connection.notify('textDocument/didChange', {
                textDocument: { uri: open.uri, version: open.version },
                contentChanges: [{ text }],
            });
            return { version: open.version, changed: true };
        }
        const uri = fileUri(file);
        this.#documents.set(key, { uri, languageId, version: 1, text, syncedAt: this.#seq });
        this.#connection.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
        while (this.#documents.size > MAX_OPEN_DOCUMENTS) {
            const oldest = this.#documents.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#close(oldest);
        }
        return { version: 1, changed: true };
    }

    closeDocument(file: string): void {
        if (this.#state === 'ready') {
            this.#close(fileKey(file));
        }
    }

    /** Tells the server about files changed on disk (1 created, 2 changed, 3 deleted). */
    filesChanged(changes: ReadonlyArray<{ readonly file: string; readonly type: 1 | 2 | 3 }>): void {
        if (this.#state === 'ready' && changes.length > 0) {
            this.#connection.notify('workspace/didChangeWatchedFiles', {
                changes: changes.map((change) => ({ uri: fileUri(change.file), type: change.type })),
            });
        }
    }

    /** The newest report on `file`, if it describes the text last sent. */
    currentReport(file: string): DiagnosticsReport | undefined {
        const key = fileKey(file);
        const open = this.#documents.get(key);
        const report = this.#reports.get(key);
        if (!open || !report || report.seq <= open.syncedAt) {
            return undefined;
        }
        return report.version === undefined || report.version >= open.version ? report : undefined;
    }

    /**
     * Waits until the server publishes diagnostics for `file` after report `after` (for `version` or later when the
     * server says which version a report is for), then takes further reports that follow within `settleMs` of each
     * other: servers often report in steps, syntax first and types later. Gives up at `deadline`.
     */
    async waitForReport(
        file: string,
        options: {
            readonly after: number;
            readonly version?: number | undefined;
            readonly deadline: number;
            readonly settleMs: number;
            readonly signal?: AbortSignal | undefined;
        },
    ): Promise<DiagnosticsReport | undefined> {
        const key = fileKey(file);
        let report = await this.#waitFor(
            () => {
                const candidate = this.#reports.get(key);
                if (!candidate || candidate.seq <= options.after) {
                    return undefined;
                }
                const stale =
                    options.version !== undefined &&
                    candidate.version !== undefined &&
                    candidate.version < options.version;
                return stale ? undefined : candidate;
            },
            options.deadline,
            options.signal,
        );
        while (report !== undefined) {
            const seen = report.seq;
            const next = await this.#waitFor(
                () => {
                    const candidate = this.#reports.get(key);
                    return candidate && candidate.seq > seen ? candidate : undefined;
                },
                Math.min(options.deadline, report.at + options.settleMs),
                options.signal,
            );
            if (next === undefined) {
                return report;
            }
            report = next;
        }
        return undefined;
    }

    /** Waits for a report on the text last sent for `file`, like `waitForReport`; at once if there is one. */
    waitForCurrent(
        file: string,
        options: { readonly deadline: number; readonly settleMs: number; readonly signal?: AbortSignal | undefined },
    ): Promise<DiagnosticsReport | undefined> {
        const open = this.#documents.get(fileKey(file));
        if (!open) {
            return Promise.resolve(undefined);
        }
        return this.waitForReport(file, { after: open.syncedAt, version: open.version, ...options });
    }

    /** Stops the server: `shutdown` and `exit`, then signals to its whole process tree if it does not go. */
    shutdown(): Promise<void> {
        this.#closing ??= this.#stop();
        return this.#closing;
    }

    async #start(): Promise<void> {
        const options = this.#options;
        let child: ChildProcess;
        try {
            child = startServerProcess({
                command: options.command,
                args: options.args,
                cwd: options.root,
                env: options.env,
            });
        } catch (error) {
            this.#failure = `${this.spec.name} could not be started (${options.command}): ${(error as Error).message}`;
            this.#closed();
            throw new Error(this.#failure);
        }
        this.#child = child;
        const reader = new MessageReader();
        child.stdout?.on('data', (chunk: Buffer) => {
            if (this.#broken) {
                return;
            }
            let results: ReturnType<MessageReader['push']>;
            try {
                results = reader.push(chunk);
            } catch (error) {
                this.#broken = true;
                this.#fail(`${this.spec.name} sent a malformed message: ${(error as Error).message}`);
                return;
            }
            for (const result of results) {
                if (result.ok) {
                    this.#connection.receive(result.message);
                }
            }
        });
        const decoder = new StringDecoder('utf8');
        let partial = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            const lines = (partial + decoder.write(chunk)).split(/\r?\n/);
            partial = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() !== '') {
                    this.#stderr.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
                    if (this.#stderr.length > STDERR_LINES) {
                        this.#stderr.shift();
                    }
                }
            }
        });
        // A broken pipe shows up as the process closing; nothing to do here.
        child.stdin?.on('error', () => undefined);
        child.stdout?.on('error', () => undefined);
        child.stderr?.on('error', () => undefined);
        child.once('exit', (code, signal) => {
            this.#exit = { code, signal };
            // Whatever the server started and left behind goes too.
            void killTree(child, 'SIGKILL');
        });
        child.once('close', () => this.#closed());

        // Errors after the start (a failed kill) change nothing: the process reports its end through `close`.
        child.on('error', () => undefined);
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.#failure ??= `${this.spec.name} could not be started (${options.command}): ${error.message}`;
                this.#closed();
                reject(new Error(this.#failure));
            };
            child.once('error', onError);
            child.once('spawn', () => {
                child.off('error', onError);
                resolve();
            });
        });

        const rootUri = fileUri(options.root);
        const initializationOptions = this.spec.initializationOptions?.(options.trusted);
        try {
            const result = await this.#connection.request<{ capabilities?: ServerCapabilities } | null>(
                'initialize',
                {
                    processId: process.pid,
                    clientInfo: options.clientInfo,
                    locale: 'en',
                    rootPath: options.root,
                    rootUri,
                    workspaceFolders: [{ uri: rootUri, name: path.basename(options.root) }],
                    ...(initializationOptions === undefined ? {} : { initializationOptions }),
                    capabilities: {
                        general: { positionEncodings: ['utf-16'] },
                        workspace: {
                            workspaceFolders: true,
                            configuration: false,
                            applyEdit: false,
                            didChangeWatchedFiles: { dynamicRegistration: false },
                            symbol: { symbolKind: { valueSet: ALL_SYMBOL_KINDS } },
                        },
                        textDocument: {
                            synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
                            publishDiagnostics: { relatedInformation: false, versionSupport: true },
                            hover: { contentFormat: ['markdown', 'plaintext'] },
                            definition: { linkSupport: true },
                            references: {},
                            documentSymbol: {
                                hierarchicalDocumentSymbolSupport: true,
                                symbolKind: { valueSet: ALL_SYMBOL_KINDS },
                            },
                        },
                        window: { workDoneProgress: false, showDocument: { support: false } },
                    },
                    trace: 'off',
                },
                { timeoutMs: options.startTimeoutMs },
            );
            this.#capabilities = result?.capabilities ?? {};
        } catch (error) {
            this.#failure ??=
                error instanceof ConnectionClosedError
                    ? error.message
                    : `${this.spec.name} did not complete its start: ${(error as Error).message}`;
            void this.shutdown();
            throw new Error(this.#failure);
        }
        if (this.#state === 'closed') {
            throw new Error(this.failure);
        }
        this.#connection.notify('initialized', {});
        this.#state = 'ready';
    }

    async #stop(): Promise<void> {
        this.#stopping = true;
        const child = this.#child;
        if (!child) {
            return;
        }
        if (this.#state === 'ready' && !hasExited(child)) {
            try {
                await this.#connection.request('shutdown', undefined, { timeoutMs: STOP_STEP_MS });
            } catch {
                // It is stopped below either way.
            }
            this.#connection.notify('exit');
        }
        if (!hasExited(child)) {
            try {
                child.stdin?.end();
            } catch {
                // The pipe is already broken; the signals below still apply.
            }
            if (!(await waitForExit(child, STOP_STEP_MS))) {
                await killTree(child, 'SIGTERM');
                if (!(await waitForExit(child, STOP_STEP_MS))) {
                    await killTree(child, 'SIGKILL');
                    await waitForExit(child, 2000);
                }
            }
        }
        await killTree(child, 'SIGKILL');
    }

    /** The stream cannot be trusted any more: kill the server; the close reports the failure. */
    #fail(reason: string): void {
        this.#failure ??= reason;
        const child = this.#child;
        if (child) {
            void killTree(child, 'SIGKILL');
        }
    }

    #closed(): void {
        if (this.#closeReported) {
            return;
        }
        this.#closeReported = true;
        this.#state = 'closed';
        this.#connection.close(new ConnectionClosedError(this.failure));
        for (const waiter of [...this.#waiters]) {
            waiter.cancel();
        }
        this.onClose?.(this, this.#stopping);
    }

    #exitText(): string {
        const exit = this.#exit;
        const how =
            exit === undefined
                ? 'stopped'
                : exit.signal !== null
                  ? `was stopped by ${exit.signal}`
                  : `exited with code ${exit.code}`;
        const tail = this.#stderr.slice(-5).join('\n');
        return `${this.spec.name} ${how}${tail === '' ? '' : `; its last output:\n${tail}`}`;
    }

    #close(key: string): void {
        const open = this.#documents.get(key);
        if (!open) {
            return;
        }
        this.#documents.delete(key);
        this.#reports.delete(key);
        this.#connection.notify('textDocument/didClose', { textDocument: { uri: open.uri } });
    }

    #waitFor<T>(check: () => T | undefined, deadline: number, signal: AbortSignal | undefined): Promise<T | undefined> {
        const now = check();
        if (now !== undefined) {
            return Promise.resolve(now);
        }
        if (this.#state === 'closed' || signal?.aborted || Date.now() >= deadline) {
            return Promise.resolve(undefined);
        }
        return new Promise((resolve) => {
            const finish = (value: T | undefined): void => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                this.#waiters.delete(waiter);
                resolve(value);
            };
            const onAbort = (): void => finish(undefined);
            const waiter: Waiter = {
                check: () => {
                    const value = check();
                    if (value !== undefined) {
                        finish(value);
                    }
                },
                cancel: () => finish(undefined),
            };
            const timer = setTimeout(() => finish(undefined), Math.max(0, deadline - Date.now()));
            this.#waiters.add(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    #onNotification(method: string, params: unknown): void {
        if (method !== 'textDocument/publishDiagnostics') {
            // Log messages, progress and telemetry are of no use here.
            return;
        }
        const report = params as Partial<PublishDiagnosticsParams> | null;
        if (typeof report?.uri !== 'string' || !Array.isArray(report.diagnostics)) {
            return;
        }
        const file = uriToFile(report.uri);
        if (file === undefined) {
            return;
        }
        const key = fileKey(file);
        this.#seq++;
        this.#reports.delete(key);
        this.#reports.set(key, {
            items: report.diagnostics,
            version: typeof report.version === 'number' ? report.version : undefined,
            seq: this.#seq,
            at: Date.now(),
        });
        if (this.#reports.size > MAX_REPORTS) {
            for (const old of this.#reports.keys()) {
                if (!this.#documents.has(old)) {
                    this.#reports.delete(old);
                    break;
                }
            }
        }
        for (const waiter of [...this.#waiters]) {
            waiter.check();
        }
    }

    #onRequest(method: string, params: unknown): unknown {
        switch (method) {
            case 'workspace/configuration': {
                const items = (params as { items?: unknown } | null)?.items;
                return Array.isArray(items) ? items.map(() => null) : [];
            }
            case 'workspace/workspaceFolders':
                return [{ uri: fileUri(this.root), name: path.basename(this.root) }];
            case 'workspace/applyEdit':
                return { applied: false, failureReason: 'Xora does not apply edits from language servers.' };
            case 'window/showDocument':
                return { success: false };
            case 'window/showMessageRequest':
            case 'window/workDoneProgress/create':
            case 'client/registerCapability':
            case 'client/unregisterCapability':
            case 'workspace/codeLens/refresh':
            case 'workspace/diagnostic/refresh':
            case 'workspace/foldingRange/refresh':
            case 'workspace/inlayHint/refresh':
            case 'workspace/inlineValue/refresh':
            case 'workspace/semanticTokens/refresh':
                return null;
            default:
                throw new ResponseError(ErrorCodes.MethodNotFound, `Unhandled method ${method}`);
        }
    }
}
