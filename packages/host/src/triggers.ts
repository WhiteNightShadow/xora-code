import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
    type CronSchedule,
    lastCronTime,
    nextCronTime,
    normalizePath,
    ownershipMatcher,
    parseCron,
    scheduleList,
    systemTimeZone,
    type TriggerSpec,
} from '@xora/workflows';
import { GitError, runGit } from '@xora/workspace';
import picomatch from 'picomatch/posix';
import type { Logger } from './log.ts';
import { defaultTreeWatch, inSkippedDir, type TreeWatcher, type WatchTree } from './tree-watch.ts';

/**
 * Workflow triggers (06 §12): cron schedules, file changes, git commits and branches, and a local webhook. The
 * service only says when a workflow should start; the workflow service decides whether a run starts, waits for
 * off-peak hours or queues. Triggers act while the app runs; schedule times passed while it was closed or the
 * system slept follow the workflow's `missed` policy.
 */

/** Longest single timer. Timers stand still while the system sleeps, so the wall clock is checked this often. */
const MAX_TIMER_MS = 60_000;
/** A schedule time noticed later than this (app closed, system asleep) counts as missed. */
export const SCHEDULE_GRACE_MS = 5 * 60_000;
export const DEFAULT_GIT_POLL_MS = 30_000;
/** Fires one git poll gives one trigger at most, e.g. after a rebase of many branches. */
const GIT_FIRES_PER_POLL = 5;
const GIT_MAX_OUTPUT = 16 * 1024 * 1024;
/** Changed paths one file fire carries at most. */
const MAX_FIRE_FILES = 200;
export const WEBHOOK_MAX_BYTES = 64 * 1024;
export const DEFAULT_WEBHOOK_INTERVAL_MS = 5_000;
export const DEFAULT_MUTE_GRACE_MS = 2_000;

export interface TriggerTarget {
    /** Names the workflow in fires and in the webhook path, e.g. the project and workflow name. */
    readonly key: string;
    readonly projectDir: string;
    readonly spec: TriggerSpec;
    /**
     * The latest schedule time already handled (epoch ms; persist the `scheduledFor` of schedule fires). Read only
     * when the key first appears, at startup or when the workflow is switched on, for `missed: 'once'`.
     */
    readonly lastScheduledAt?: number;
    /** Bearer token of the webhook; without one the webhook stays off. */
    readonly webhookToken?: string;
}

export type TriggerReason = 'schedule' | 'files' | 'git' | 'webhook';

export interface GitTriggerEvent {
    readonly event: 'commit' | 'branch';
    readonly branch: string;
    /** The branch's new tip. */
    readonly commit: string;
}

export interface TriggerFire {
    readonly key: string;
    readonly reason: TriggerReason;
    /** When it fired, epoch ms. */
    readonly at: number;
    /** The schedule time it fired for, epoch ms. */
    readonly scheduledFor?: number;
    /** The schedule time passed while the app was closed or the system slept (`missed: 'once'`). */
    readonly missed?: boolean;
    /** Changed paths relative to the project, `/`-separated and sorted, at most 200. */
    readonly files?: readonly string[];
    readonly git?: GitTriggerEvent;
    /** The webhook body: parsed JSON, or text. Untrusted input. */
    readonly payload?: unknown;
}

export type TriggerListener = (fire: TriggerFire) => unknown;

/** A new webhook token: 32 random bytes, base64url. */
export function newWebhookToken(): string {
    return randomBytes(32).toString('base64url');
}

export interface TriggerServiceOptions {
    readonly log: Logger;
    /** Wall clock in epoch ms; tests pass a fake one. */
    readonly now?: () => number;
    readonly gitPollMs?: number;
    /** Port of the webhook server: 0 (the default) picks a free one, a taken port falls back to that. */
    readonly webhookPort?: number;
    /** Shortest time between two webhook fires of one key; requests in between get 429. */
    readonly webhookIntervalMs?: number;
    /** How long file events stay dropped after the last unmute: late events of the muted writes. */
    readonly muteGraceMs?: number;
    readonly watchTree?: WatchTree;
}

type Timer = ReturnType<typeof setTimeout>;

interface ScheduleState {
    readonly schedules: readonly CronSchedule[];
    readonly timeZone: string;
    readonly missed: 'skip' | 'once';
    /** Schedule times up to here are handled. */
    cursor: number;
    next: number | undefined;
    timer: Timer | undefined;
}

interface FileSubscription {
    readonly key: string;
    readonly matches: (relativePath: string) => boolean;
    readonly debounceMs: number;
    readonly pending: Set<string>;
    timer: Timer | undefined;
}

interface FileWatch {
    readonly watcher: TreeWatcher;
    readonly subscriptions: Map<string, FileSubscription>;
}

interface GitSubscription {
    readonly key: string;
    readonly events: ReadonlySet<'commit' | 'branch'>;
    readonly matches: (branch: string) => boolean;
    /** Branch tips at the last poll; undefined until the first poll, which is the baseline. */
    refs: ReadonlyMap<string, string> | undefined;
}

interface GitPoller {
    readonly root: string;
    readonly subscriptions: Map<string, GitSubscription>;
    timer: Timer | undefined;
    polling: Promise<void> | undefined;
    /** The last failure reported, so a broken repository logs once rather than every poll. */
    failure: string | undefined;
}

interface ActiveTarget {
    readonly root: string;
    /** What each part was started from, to restart only the parts that changed. */
    readonly parts: { readonly schedule: string; readonly files: string; readonly git: string };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function partsOf(target: TriggerTarget, root: string): ActiveTarget['parts'] {
    const { spec } = target;
    return {
        schedule: JSON.stringify([spec.schedule ?? null, spec.timezone ?? null, spec.missed]),
        files: JSON.stringify([root, spec.files ?? null]),
        git: JSON.stringify([root, spec.git ?? null]),
    };
}

export class TriggerService {
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #gitPollMs: number;
    readonly #webhookPort: number;
    readonly #webhookIntervalMs: number;
    readonly #muteGraceMs: number;
    readonly #watchTree: WatchTree;
    readonly #listeners = new Set<TriggerListener>();
    readonly #targets = new Map<string, ActiveTarget>();
    readonly #schedules = new Map<string, ScheduleState>();
    /** By project root, shared by the triggers of one project. */
    readonly #fileWatches = new Map<string, FileWatch>();
    readonly #gitPollers = new Map<string, GitPoller>();
    /** Webhook token by key. */
    readonly #webhooks = new Map<string, string>();
    readonly #lastWebhook = new Map<string, number>();
    readonly #fileMutes = new Map<string, number>();
    readonly #fileMutedUntil = new Map<string, number>();
    readonly #gitMutes = new Map<string, number>();
    #server: Server | undefined;
    #port: number | undefined;
    #starting: Promise<void> | undefined;
    #queue: Promise<void> = Promise.resolve();
    #closed = false;

    constructor(options: TriggerServiceOptions) {
        this.#log = options.log;
        this.#now = options.now ?? (() => Date.now());
        this.#gitPollMs = options.gitPollMs ?? DEFAULT_GIT_POLL_MS;
        this.#webhookPort = options.webhookPort ?? 0;
        this.#webhookIntervalMs = options.webhookIntervalMs ?? DEFAULT_WEBHOOK_INTERVAL_MS;
        this.#muteGraceMs = options.muteGraceMs ?? DEFAULT_MUTE_GRACE_MS;
        this.#watchTree = options.watchTree ?? defaultTreeWatch();
    }

    onFire(listener: TriggerListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Makes the running triggers match `targets`: starts new ones, restarts the parts of a target that changed
     * (its schedule, files or git part) and stops the rest. Resolves once git baselines are taken and the webhook
     * server listens; calls run one after another. A key seen for the first time catches up on a missed schedule
     * time (`missed: 'once'`) before this resolves.
     */
    update(targets: readonly TriggerTarget[]): Promise<void> {
        const run = this.#queue.then(() => this.#apply(targets));
        this.#queue = run.catch(() => undefined);
        return run;
    }

    /** The next schedule time of a key, epoch ms; for showing when a workflow runs next. */
    nextScheduledAt(key: string): number | undefined {
        return this.#schedules.get(key)?.next;
    }

    /** The webhook URL of a key, once the server listens; undefined for keys without a webhook. */
    webhookUrl(key: string): string | undefined {
        if (this.#port === undefined || !this.#webhooks.has(key)) {
            return undefined;
        }
        return `http://127.0.0.1:${this.#port}/hooks/${encodeURIComponent(key)}`;
    }

    /** The port the webhook server listens on; worth keeping in the settings so URLs survive a restart. */
    webhookPort(): number | undefined {
        return this.#port;
    }

    /**
     * Drops file events under `projectDir` until the returned function is called, and for a short grace period
     * after, so a running workflow's own edits do not start it again. Mutes nest.
     */
    muteFiles(projectDir: string): () => void {
        const root = path.resolve(projectDir);
        return this.#mute(this.#fileMutes, root, () => {
            this.#fileMutedUntil.set(root, this.#now() + this.#muteGraceMs);
        });
    }

    /**
     * Takes commits and branches made under `projectDir` until the returned function is called into the baseline
     * without firing, so a workflow that commits does not start itself again. Mutes nest.
     */
    muteGit(projectDir: string): () => void {
        const root = path.resolve(projectDir);
        return this.#mute(this.#gitMutes, root, () => {
            // A fresh, silent poll takes in what the muted run committed before the next regular one sees it.
            const poller = this.#gitPollers.get(root);
            if (poller) {
                void this.#poll(poller, true);
            }
        });
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        // A git poll still running keeps its repository busy (Windows will not delete a process's working folder).
        const polling = [...this.#gitPollers.values()].map((poller) => poller.polling);
        for (const key of [...this.#targets.keys()]) {
            this.#stop(key);
        }
        this.#listeners.clear();
        await Promise.all(polling);
        await this.#starting;
        const server = this.#server;
        this.#server = undefined;
        this.#port = undefined;
        if (server) {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    }

    // Targets ------------------------------------------------------------------------------------------------

    async #apply(targets: readonly TriggerTarget[]): Promise<void> {
        if (this.#closed) {
            return;
        }
        const wanted = new Map(targets.map((target) => [target.key, target]));
        for (const key of [...this.#targets.keys()]) {
            if (!wanted.has(key)) {
                this.#stop(key);
            }
        }
        const caughtUp: TriggerFire[] = [];
        const polls: Promise<void>[] = [];
        for (const target of wanted.values()) {
            const before = this.#targets.get(target.key);
            const root = path.resolve(target.projectDir);
            const parts = partsOf(target, root);
            if (before?.parts.schedule !== parts.schedule) {
                this.#stopSchedule(target.key);
                const fire = this.#startSchedule(target, before === undefined);
                if (fire) {
                    caughtUp.push(fire);
                }
            }
            if (before?.parts.files !== parts.files) {
                this.#unwatchFiles(target.key, before?.root);
                this.#watchFiles(target, root);
            }
            if (before?.parts.git !== parts.git) {
                this.#unwatchGit(target.key, before?.root);
                const poll = this.#watchGit(target, root);
                if (poll) {
                    polls.push(poll);
                }
            }
            this.#setWebhook(target);
            this.#targets.set(target.key, { root, parts });
        }
        await Promise.all(polls);
        if (this.#webhooks.size > 0) {
            await this.#startServer();
        }
        for (const fire of caughtUp) {
            this.#emit(fire);
        }
    }

    #stop(key: string): void {
        const active = this.#targets.get(key);
        this.#targets.delete(key);
        this.#stopSchedule(key);
        this.#unwatchFiles(key, active?.root);
        this.#unwatchGit(key, active?.root);
        this.#webhooks.delete(key);
        this.#lastWebhook.delete(key);
    }

    #emit(fire: TriggerFire): void {
        if (this.#closed) {
            return;
        }
        this.#log.info(`trigger ${fire.key}: ${fire.reason}${fire.missed ? ' (missed while closed or asleep)' : ''}`);
        for (const listener of [...this.#listeners]) {
            try {
                const result = listener(fire);
                if (result instanceof Promise) {
                    result.catch((error: unknown) =>
                        this.#log.error(`trigger listener failed for ${fire.key}: ${errorText(error)}`),
                    );
                }
            } catch (error) {
                this.#log.error(`trigger listener failed for ${fire.key}: ${errorText(error)}`);
            }
        }
    }

    #mute(counts: Map<string, number>, root: string, released: () => void): () => void {
        counts.set(root, (counts.get(root) ?? 0) + 1);
        let done = false;
        return () => {
            if (done) {
                return;
            }
            done = true;
            const left = (counts.get(root) ?? 1) - 1;
            if (left > 0) {
                counts.set(root, left);
                return;
            }
            counts.delete(root);
            released();
        };
    }

    // Schedules ----------------------------------------------------------------------------------------------

    #startSchedule(target: TriggerTarget, fresh: boolean): TriggerFire | undefined {
        const expressions = scheduleList(target.spec.schedule);
        if (expressions.length === 0) {
            return undefined;
        }
        const now = this.#now();
        const timeZone = target.spec.timezone ?? systemTimeZone();
        let schedules: CronSchedule[];
        let next: number | undefined;
        const cursor = Math.max(now, target.lastScheduledAt ?? now);
        try {
            schedules = expressions.map((expression) => parseCron(expression));
            next = nextCronTime(schedules, cursor, timeZone)?.getTime();
        } catch (error) {
            this.#log.warn(`trigger ${target.key}: schedule not started: ${errorText(error)}`);
            return undefined;
        }
        const state: ScheduleState = {
            schedules,
            timeZone,
            missed: target.spec.missed,
            cursor,
            next,
            timer: undefined,
        };
        this.#schedules.set(target.key, state);
        this.#arm(target.key, state);
        // Only a key seen for the first time looks back; a changed schedule starts from now.
        if (!fresh || target.lastScheduledAt === undefined) {
            return undefined;
        }
        const missed = lastCronTime(schedules, target.lastScheduledAt, now, timeZone)?.getTime();
        return missed === undefined ? undefined : this.#scheduleFire(target.key, state, missed, now);
    }

    #stopSchedule(key: string): void {
        const state = this.#schedules.get(key);
        if (state) {
            clearTimeout(state.timer);
            this.#schedules.delete(key);
        }
    }

    #arm(key: string, state: ScheduleState): void {
        clearTimeout(state.timer);
        state.timer = undefined;
        if (state.next === undefined || this.#closed) {
            return;
        }
        const delay = Math.min(Math.max(state.next - this.#now(), 0), MAX_TIMER_MS);
        state.timer = setTimeout(() => this.#tick(key, state), delay);
        state.timer.unref?.();
    }

    #tick(key: string, state: ScheduleState): void {
        if (this.#schedules.get(key) !== state || state.next === undefined) {
            return;
        }
        const now = this.#now();
        if (now < state.next) {
            // The timer was capped, or the clock was set back: keep waiting for the wall clock.
            this.#arm(key, state);
            return;
        }
        // Everything up to now is handled at once: after a long sleep only the latest time counts.
        const latest = lastCronTime(state.schedules, state.cursor, now, state.timeZone)?.getTime() ?? state.next;
        state.cursor = now;
        state.next = nextCronTime(state.schedules, now, state.timeZone)?.getTime();
        this.#arm(key, state);
        const fire = this.#scheduleFire(key, state, latest, now);
        if (fire) {
            this.#emit(fire);
        }
    }

    #scheduleFire(key: string, state: ScheduleState, scheduledFor: number, now: number): TriggerFire | undefined {
        if (now - scheduledFor <= SCHEDULE_GRACE_MS) {
            return { key, reason: 'schedule', at: now, scheduledFor };
        }
        if (state.missed === 'once') {
            return { key, reason: 'schedule', at: now, scheduledFor, missed: true };
        }
        this.#log.info(`trigger ${key}: skipped the schedule time ${new Date(scheduledFor).toISOString()} (missed)`);
        return undefined;
    }

    // Files --------------------------------------------------------------------------------------------------

    #watchFiles(target: TriggerTarget, root: string): void {
        const files = target.spec.files;
        if (!files) {
            return;
        }
        let watch = this.#fileWatches.get(root);
        if (!watch) {
            try {
                const watcher = this.#watchTree(
                    root,
                    (relative) => this.#fileChanged(root, relative),
                    (error) => this.#log.warn(`file trigger in ${root}: ${error.message}`),
                );
                watch = { watcher, subscriptions: new Map() };
            } catch (error) {
                this.#log.warn(`trigger ${target.key}: cannot watch ${root}: ${errorText(error)}`);
                return;
            }
            this.#fileWatches.set(root, watch);
        }
        const included = ownershipMatcher(files.paths);
        const ignored = ownershipMatcher(files.ignore);
        watch.subscriptions.set(target.key, {
            key: target.key,
            matches: (relative) => included(relative) && !ignored(relative),
            debounceMs: files.debounceSeconds * 1000,
            pending: new Set(),
            timer: undefined,
        });
    }

    #unwatchFiles(key: string, root: string | undefined): void {
        const watch = root === undefined ? undefined : this.#fileWatches.get(root);
        const subscription = watch?.subscriptions.get(key);
        if (!watch || !subscription || root === undefined) {
            return;
        }
        clearTimeout(subscription.timer);
        watch.subscriptions.delete(key);
        if (watch.subscriptions.size === 0) {
            watch.watcher.close();
            this.#fileWatches.delete(root);
        }
    }

    #filesMuted(root: string): boolean {
        return (this.#fileMutes.get(root) ?? 0) > 0 || this.#now() < (this.#fileMutedUntil.get(root) ?? 0);
    }

    #fileChanged(root: string, relative: string): void {
        const watch = this.#fileWatches.get(root);
        const file = normalizePath(relative);
        if (!watch || file === '' || inSkippedDir(file) || this.#filesMuted(root)) {
            return;
        }
        for (const subscription of watch.subscriptions.values()) {
            if (!subscription.matches(file)) {
                continue;
            }
            if (subscription.pending.size < MAX_FIRE_FILES) {
                subscription.pending.add(file);
            }
            // Fire once the changes settle: every change starts the wait again.
            clearTimeout(subscription.timer);
            subscription.timer = setTimeout(() => this.#filesSettled(watch, subscription), subscription.debounceMs);
            subscription.timer.unref?.();
        }
    }

    #filesSettled(watch: FileWatch, subscription: FileSubscription): void {
        subscription.timer = undefined;
        if (watch.subscriptions.get(subscription.key) !== subscription || subscription.pending.size === 0) {
            return;
        }
        const files = [...subscription.pending].sort();
        subscription.pending.clear();
        this.#emit({ key: subscription.key, reason: 'files', at: this.#now(), files });
    }

    // Git ----------------------------------------------------------------------------------------------------

    #watchGit(target: TriggerTarget, root: string): Promise<void> | undefined {
        const git = target.spec.git;
        if (!git) {
            return undefined;
        }
        const branchMatcher = git.branches.length > 0 ? picomatch([...git.branches], { dot: true }) : undefined;
        let poller = this.#gitPollers.get(root);
        if (!poller) {
            poller = { root, subscriptions: new Map(), timer: undefined, polling: undefined, failure: undefined };
            this.#gitPollers.set(root, poller);
        }
        poller.subscriptions.set(target.key, {
            key: target.key,
            events: new Set(git.on),
            matches: (branch) => branchMatcher?.(branch) ?? true,
            refs: undefined,
        });
        // The next poll is the new subscription's baseline; take it now.
        return this.#poll(poller);
    }

    #unwatchGit(key: string, root: string | undefined): void {
        const poller = root === undefined ? undefined : this.#gitPollers.get(root);
        if (!poller?.subscriptions.delete(key) || root === undefined) {
            return;
        }
        if (poller.subscriptions.size === 0) {
            clearTimeout(poller.timer);
            this.#gitPollers.delete(root);
        }
    }

    #gitMuted(root: string): boolean {
        return (this.#gitMutes.get(root) ?? 0) > 0;
    }

    /** Polls after any poll in flight, so every call sees the refs as they are now. Never rejects. */
    #poll(poller: GitPoller, silent = false): Promise<void> {
        const run = (poller.polling ?? Promise.resolve())
            .then(() => this.#pollOnce(poller, silent))
            .catch((error: unknown) => this.#log.error(`git trigger in ${poller.root}: ${errorText(error)}`));
        poller.polling = run;
        void run.finally(() => {
            if (poller.polling === run) {
                poller.polling = undefined;
            }
        });
        return run;
    }

    async #pollOnce(poller: GitPoller, forceSilent: boolean): Promise<void> {
        if (this.#gitPollers.get(poller.root) !== poller) {
            return;
        }
        clearTimeout(poller.timer);
        // Decided before git runs: commits a muted run made are taken in by a poll that started while muted.
        const silent = forceSilent || this.#gitMuted(poller.root);
        let refs: Map<string, string> | undefined;
        try {
            refs = await readBranches(poller.root);
            poller.failure = undefined;
        } catch (error) {
            const text = errorText(error);
            if (poller.failure !== text) {
                poller.failure = text;
                this.#log.warn(`git trigger in ${poller.root}: ${text}`);
            }
        }
        if (this.#gitPollers.get(poller.root) !== poller) {
            return;
        }
        const fires: TriggerFire[] = [];
        for (const subscription of refs ? poller.subscriptions.values() : []) {
            const before = subscription.refs;
            subscription.refs = refs;
            if (!before || silent || !refs) {
                continue;
            }
            const found = gitFires(subscription, before, refs, this.#now());
            if (found.length > GIT_FIRES_PER_POLL) {
                this.#log.warn(
                    `trigger ${subscription.key}: ${found.length} branches changed at once, firing for the first ${GIT_FIRES_PER_POLL}`,
                );
            }
            fires.push(...found.slice(0, GIT_FIRES_PER_POLL));
        }
        poller.timer = setTimeout(() => void this.#poll(poller), this.#gitPollMs);
        poller.timer.unref?.();
        for (const fire of fires) {
            this.#emit(fire);
        }
    }

    // Webhook ------------------------------------------------------------------------------------------------

    #setWebhook(target: TriggerTarget): void {
        const token = target.webhookToken?.trim();
        if (target.spec.webhook && token) {
            this.#webhooks.set(target.key, token);
            return;
        }
        if (target.spec.webhook && !this.#targets.has(target.key)) {
            this.#log.warn(`trigger ${target.key}: webhook switched on without a token, left off`);
        }
        this.#webhooks.delete(target.key);
    }

    #startServer(): Promise<void> {
        if (this.#server || this.#closed) {
            return Promise.resolve();
        }
        this.#starting ??= this.#listen().finally(() => {
            this.#starting = undefined;
        });
        return this.#starting;
    }

    async #listen(): Promise<void> {
        const listen = (port: number) =>
            new Promise<Server>((resolve, reject) => {
                const server = createServer((request, response) => this.#handle(request, response));
                server.requestTimeout = 15_000;
                server.headersTimeout = 10_000;
                server.keepAliveTimeout = 5_000;
                server.once('error', reject);
                server.listen(port, '127.0.0.1', () => {
                    server.off('error', reject);
                    resolve(server);
                });
            });
        let server: Server;
        try {
            try {
                server = await listen(this.#webhookPort);
            } catch (error) {
                if (this.#webhookPort === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
                    throw error;
                }
                this.#log.warn(`webhook port ${this.#webhookPort} is taken, listening on a free one`);
                server = await listen(0);
            }
        } catch (error) {
            this.#log.error(`webhook server not started: ${errorText(error)}`);
            return;
        }
        server.on('error', (error) => this.#log.warn(`webhook server: ${error.message}`));
        server.unref();
        if (this.#closed) {
            server.close();
            return;
        }
        this.#server = server;
        this.#port = (server.address() as AddressInfo).port;
        this.#log.info(`webhook server listening on 127.0.0.1:${this.#port}`);
    }

    #handle(request: IncomingMessage, response: ServerResponse): void {
        const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
            if (response.headersSent) {
                return;
            }
            const text = JSON.stringify(body);
            response.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(Buffer.byteLength(text)),
                'cache-control': 'no-store',
                ...headers,
            });
            response.end(text);
        };
        request.on('error', () => undefined);
        // Another host name means a page in a browser reached us through DNS rebinding.
        if (!isLoopbackHost(request.headers.host)) {
            reply(403, { error: '只接受本机地址的请求' });
            return;
        }
        const key = hookKey(request.url);
        if (key === undefined) {
            reply(404, { error: '没有这个地址' });
            return;
        }
        if (request.method !== 'POST') {
            reply(405, { error: 'webhook只接受post请求' }, { allow: 'POST' });
            return;
        }
        const token = this.#webhooks.get(key);
        if (token === undefined) {
            reply(404, { error: '没有这个webhook，或者工作流没有打开webhook触发' });
            return;
        }
        if (!sameToken(bearerToken(request.headers.authorization), token)) {
            reply(401, { error: '缺少token或者token不对' }, { 'www-authenticate': 'Bearer' });
            return;
        }
        const wait = this.#webhookWait(key);
        if (wait > 0) {
            reply(429, { error: `触发太频繁，${wait}秒后再试` }, { 'retry-after': String(wait) });
            return;
        }
        if (Number(request.headers['content-length'] ?? 0) > WEBHOOK_MAX_BYTES) {
            reply(413, { error: '请求体超过64kb' }, { connection: 'close' });
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        request.on('data', (chunk: Buffer) => {
            if (rejected) {
                return;
            }
            size += chunk.length;
            if (size > WEBHOOK_MAX_BYTES) {
                rejected = true;
                reply(413, { error: '请求体超过64kb' }, { connection: 'close' });
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (rejected) {
                return;
            }
            const body = parseBody(Buffer.concat(chunks), request.headers['content-type']);
            if (!body.ok) {
                reply(400, { error: '请求体不是合法的json' });
                return;
            }
            // Checked again: the webhook may have been switched off, or another request accepted, meanwhile.
            if (this.#webhooks.get(key) !== token) {
                reply(404, { error: '没有这个webhook，或者工作流没有打开webhook触发' });
                return;
            }
            const late = this.#webhookWait(key);
            if (late > 0) {
                reply(429, { error: `触发太频繁，${late}秒后再试` }, { 'retry-after': String(late) });
                return;
            }
            const at = this.#now();
            this.#lastWebhook.set(key, at);
            reply(202, { accepted: true });
            this.#emit({
                key,
                reason: 'webhook',
                at,
                ...(body.payload === undefined ? {} : { payload: body.payload }),
            });
        });
    }

    /** Seconds until the key may fire again; 0 when it may now. */
    #webhookWait(key: string): number {
        const last = this.#lastWebhook.get(key);
        const left = last === undefined ? 0 : last + this.#webhookIntervalMs - this.#now();
        return left > 0 ? Math.ceil(left / 1000) : 0;
    }
}

// Helpers --------------------------------------------------------------------------------------------------

/** Local branches and their tips. */
async function readBranches(root: string): Promise<Map<string, string>> {
    const args = ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'];
    const result = await runGit(args, { cwd: root, maxBuffer: GIT_MAX_OUTPUT });
    if (result.code !== 0) {
        throw new GitError(args, result.code, result.stderr);
    }
    const refs = new Map<string, string>();
    for (const line of result.stdout.toString('utf8').split('\n')) {
        // Ref names cannot contain spaces.
        const [commit, name] = line.split(' ');
        if (commit && name?.startsWith('refs/heads/')) {
            refs.set(name.slice('refs/heads/'.length), commit);
        }
    }
    return refs;
}

/**
 * Git fires between two polls, by branch name. A moved tip is a commit (a reset counts too); a new branch is a
 * `branch` event, or a commit when only commits are watched and its tip was no branch's tip before.
 */
function gitFires(
    subscription: GitSubscription,
    before: ReadonlyMap<string, string>,
    after: ReadonlyMap<string, string>,
    at: number,
): TriggerFire[] {
    const knownTips = new Set(before.values());
    const fires: TriggerFire[] = [];
    for (const branch of [...after.keys()].sort()) {
        const commit = after.get(branch) as string;
        const previous = before.get(branch);
        if (previous === commit || !subscription.matches(branch)) {
            continue;
        }
        let event: 'commit' | 'branch' | undefined;
        if (previous !== undefined) {
            event = subscription.events.has('commit') ? 'commit' : undefined;
        } else if (subscription.events.has('branch')) {
            event = 'branch';
        } else if (subscription.events.has('commit') && !knownTips.has(commit)) {
            event = 'commit';
        }
        if (event) {
            fires.push({ key: subscription.key, reason: 'git', at, git: { event, branch, commit } });
        }
    }
    return fires;
}

function isLoopbackHost(host: string | undefined): boolean {
    if (host === undefined) {
        return true;
    }
    const name = host.trim().toLowerCase().replace(/:\d+$/, '');
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** The key in `/hooks/<key>`, decoded; undefined for any other path. */
function hookKey(url: string | undefined): string | undefined {
    const match = /^\/hooks\/([^/?#]+)\/?(?:\?.*)?$/.exec(url ?? '');
    if (!match?.[1]) {
        return undefined;
    }
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return undefined;
    }
}

function bearerToken(header: string | undefined): string {
    return /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '')?.[1] ?? '';
}

/** Compares in constant time whatever the lengths: both sides are hashed first. */
function sameToken(given: string, expected: string): boolean {
    const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
    return given !== '' && timingSafeEqual(digest(given), digest(expected));
}

/** JSON when the body says it is JSON, text otherwise; an empty body has no payload. */
function parseBody(body: Buffer, contentType: string | undefined): { ok: true; payload?: unknown } | { ok: false } {
    if (body.length === 0) {
        return { ok: true };
    }
    const text = body.toString('utf8');
    if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? '')) {
        try {
            return { ok: true, payload: JSON.parse(text) as unknown };
        } catch {
            return { ok: false };
        }
    }
    return { ok: true, payload: text };
}
