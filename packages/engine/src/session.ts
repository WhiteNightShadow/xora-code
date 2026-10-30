import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Message, ModelInfo, ProviderConnection } from '@xora/providers';
import { findModel, getPreset } from '@xora/providers';
import type { BackgroundJob, JobRegistry, TodoItem } from '@xora/tools';
import type { McpManager } from '@xora/mcp';
import { type ConnectionConfig, type ModelTarget, publicConfig, type SessionConfig } from './config.ts';
import { type SessionEntry, SessionFile } from './store.ts';

export class SessionBusyError extends Error {
    constructor() {
        super('a prompt is already running in this session');
        this.name = 'SessionBusyError';
    }
}

class Jobs implements JobRegistry {
    readonly #jobs = new Map<string, BackgroundJob>();

    add(job: BackgroundJob): void {
        this.#jobs.set(job.id, job);
    }

    get(id: string): BackgroundJob | undefined {
        return this.#jobs.get(id);
    }

    list(): readonly BackgroundJob[] {
        return [...this.#jobs.values()];
    }

    killAll(): void {
        for (const job of this.#jobs.values()) {
            if (job.running) {
                job.kill();
            }
        }
    }
}

export function toConnection(config: ConnectionConfig): ProviderConnection {
    const preset = getPreset(config.presetId);
    if (!preset) {
        throw new Error(`unknown provider preset ${config.presetId}`);
    }
    return {
        preset,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.wire ? { wire: config.wire } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.extraModels ? { extraModels: config.extraModels as ProviderConnection['extraModels'] } : {}),
    };
}

export interface ResolvedTarget {
    readonly connection: ProviderConnection;
    readonly model: ModelInfo;
    /** `presetId/modelId`, the identity reasoning is tied to. */
    readonly key: string;
}

export function resolveTarget(target: ModelTarget): ResolvedTarget {
    const connection = toConnection(target.connection);
    return {
        connection,
        model: findModel(connection, target.model),
        key: `${connection.preset.id}/${target.model}`,
    };
}

/**
 * State of one ACP session: the message history (the model context), its todo list, background jobs and the
 * configuration the host last sent. Everything except the configuration's secrets is persisted.
 */
export class EngineSession {
    readonly id: string;
    readonly cwd: string;
    readonly roots: readonly string[];
    readonly dir: string;
    readonly artifactsDir: string;
    readonly file: SessionFile;
    readonly jobs = new Jobs();
    config: SessionConfig;
    /** Full history, never shortened. */
    readonly history: Message[] = [];
    todos: readonly TodoItem[] = [];
    title: string | undefined;
    /** Effective context starts here; earlier messages are represented by `summary`. */
    contextStart = 0;
    summary: string | undefined;
    /** Tool results with an index below this are replaced by placeholders (compaction level 2). */
    prunedUpTo = 0;
    /** Prompt tokens reported for the latest request, for the context meter and compaction triggers. */
    lastPromptTokens = 0;
    /** MCP servers the client configured for this session (09 §2). */
    mcp: McpManager | undefined;
    #abort: AbortController | undefined;
    #artifactCounter = 0;

    constructor(options: {
        id: string;
        cwd: string;
        roots: readonly string[];
        dir: string;
        config: SessionConfig;
    }) {
        this.id = options.id;
        this.cwd = options.cwd;
        this.roots = options.roots;
        this.dir = options.dir;
        this.artifactsDir = path.join(options.dir, 'artifacts');
        this.file = new SessionFile(options.dir);
        this.config = options.config;
    }

    /** Rebuilds state from the session file. */
    restore(entries: readonly SessionEntry[]): void {
        for (const entry of entries) {
            switch (entry.t) {
                case 'message':
                    this.history.push(entry.message);
                    break;
                case 'todos':
                    this.todos = entry.items;
                    break;
                case 'title':
                    this.title = entry.title;
                    break;
                case 'compaction':
                    this.contextStart = entry.keepFrom;
                    this.summary = entry.summary;
                    this.prunedUpTo = Math.max(this.prunedUpTo, entry.keepFrom);
                    break;
                case 'prune':
                    this.prunedUpTo = Math.max(this.prunedUpTo, entry.upTo);
                    break;
                default:
                    break;
            }
        }
    }

    get busy(): boolean {
        return this.#abort !== undefined;
    }

    begin(): AbortController {
        if (this.#abort) {
            throw new SessionBusyError();
        }
        this.#abort = new AbortController();
        return this.#abort;
    }

    end(): void {
        this.#abort = undefined;
    }

    cancel(): void {
        this.#abort?.abort();
    }

    configure(config: SessionConfig): void {
        this.config = config;
        this.file.append({ t: 'config', ts: Date.now(), config: publicConfig(config) });
    }

    append(message: Message): void {
        this.history.push(message);
        this.file.append({ t: 'message', ts: Date.now(), message });
    }

    setTodos(items: readonly TodoItem[]): void {
        this.todos = items;
        this.file.append({ t: 'todos', ts: Date.now(), items });
    }

    setTitle(title: string): void {
        this.title = title;
        this.file.append({ t: 'title', ts: Date.now(), title });
    }

    saveArtifact(name: string, content: string): string {
        mkdirSync(this.artifactsDir, { recursive: true });
        this.#artifactCounter++;
        const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'output';
        const file = path.join(this.artifactsDir, `${Date.now()}-${this.#artifactCounter}-${safe}.txt`);
        writeFileSync(file, content, 'utf8');
        return file;
    }

    /** Whether the user message being added is the first one, which carries the environment block. */
    get isFirstPrompt(): boolean {
        return !this.history.some((message) => message.role === 'user');
    }

    dispose(): void {
        this.cancel();
        this.jobs.killAll();
        void this.mcp?.stopAll().catch(() => undefined);
        this.mcp = undefined;
    }
}
