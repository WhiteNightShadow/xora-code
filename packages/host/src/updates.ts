import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '@xora/protocol';
import {
    type BundleManifest,
    isSafeRelativePath,
    isShellCompatible,
    MANIFEST_FILE,
    parseManifest,
} from '@xora/updater';
import semver from 'semver';
import { z } from 'zod';
import type { Bus } from './bus.ts';
import type { Logger } from './log.ts';
import type { SettingsService } from './settings.ts';
import type { ShellApi } from './shell.ts';

/**
 * Feed published next to the app bundles (12 §3, §7): `feed-<channel>.json` names the newest bundle; its
 * signed manifest lists every file, which is fetched from the manifest's directory. Files that are unchanged
 * from the running bundle are copied locally instead of downloaded.
 */
const FeedSchema = z.object({
    schemaVersion: z.literal(1),
    channel: z.string(),
    version: z.string(),
    /** Manifest URL, absolute or relative to the feed. */
    manifest: z.string().min(1),
    notes: z.string().optional(),
    publishedAt: z.string().optional(),
    /** Versions that must not run; clients on them roll back (12 §7). */
    revoked: z.array(z.string()).optional(),
});

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60_000;

function allowedUrl(url: URL): boolean {
    return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    );
}

export class UpdateService {
    readonly #settings: SettingsService;
    readonly #shell: ShellApi;
    readonly #bus: Bus;
    readonly #log: Logger;
    readonly #downloadsDir: string;
    readonly #bundleDir: string;
    readonly #bundleVersion: string;
    readonly #shellVersion: string;
    readonly #fetch: typeof fetch;
    #status: UpdateStatus;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #checking: Promise<UpdateStatus> | undefined;

    constructor(options: {
        settings: SettingsService;
        shell: ShellApi;
        bus: Bus;
        log: Logger;
        downloadsDir: string;
        bundleDir: string;
        bundleVersion: string;
        shellVersion: string;
        fetch?: typeof fetch;
    }) {
        this.#settings = options.settings;
        this.#shell = options.shell;
        this.#bus = options.bus;
        this.#log = options.log;
        this.#downloadsDir = options.downloadsDir;
        this.#bundleDir = options.bundleDir;
        this.#bundleVersion = options.bundleVersion;
        this.#shellVersion = options.shellVersion;
        this.#fetch = options.fetch ?? fetch;
        this.#status = {
            bundleVersion: options.bundleVersion,
            shellVersion: options.shellVersion,
            channel: options.settings.get().update.channel,
            state: 'idle',
        };
    }

    status(): UpdateStatus {
        return this.#status;
    }

    #set(patch: Partial<UpdateStatus>): UpdateStatus {
        this.#status = { ...this.#status, ...patch, channel: this.#settings.get().update.channel };
        this.#bus.broadcast('update.changed', { status: this.#status });
        return this.#status;
    }

    feedUrl(): string | undefined {
        const override = process.env.XORA_UPDATE_FEED?.trim();
        const { feedUrl, channel } = this.#settings.get().update;
        const template = override || feedUrl.trim();
        return template ? template.replaceAll('{channel}', channel) : undefined;
    }

    startAutoCheck(): void {
        const schedule = (delay: number) => {
            this.#timer = setTimeout(() => {
                if (this.#settings.get().update.autoCheck) {
                    void this.check().catch(() => undefined);
                }
                schedule(CHECK_INTERVAL_MS);
            }, delay);
            this.#timer.unref?.();
        };
        // Drills ask for an immediate check; normal launches wait so startup stays quick.
        schedule(process.env.XORA_UPDATE_CHECK_ON_START === '1' ? 0 : FIRST_CHECK_DELAY_MS);
    }

    check(): Promise<UpdateStatus> {
        this.#checking ??= this.#check().finally(() => {
            this.#checking = undefined;
        });
        return this.#checking;
    }

    async #getJson(url: URL): Promise<unknown> {
        const response = await this.#fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`${url.href}: http ${response.status}`);
        }
        return response.json();
    }

    async #check(): Promise<UpdateStatus> {
        const feedUrl = this.feedUrl();
        if (!feedUrl) {
            return this.#set({ state: 'disabled' });
        }
        this.#set({ state: 'checking', error: undefined });
        try {
            const feed = new URL(feedUrl);
            if (!allowedUrl(feed)) {
                throw new Error('update feeds must use https');
            }
            const parsed = FeedSchema.parse(await this.#getJson(feed));
            if (!semver.valid(parsed.version) || !semver.gt(parsed.version, this.#bundleVersion)) {
                return this.#set({ state: 'up_to_date', checkedAt: Date.now(), available: undefined });
            }
            if (this.#status.staged === parsed.version) {
                return this.#set({ state: 'ready', checkedAt: Date.now() });
            }
            this.#set({
                state: 'downloading',
                available: { version: parsed.version, ...(parsed.notes ? { notes: parsed.notes } : {}) },
            });
            const manifestUrl = new URL(parsed.manifest, feed);
            if (!allowedUrl(manifestUrl)) {
                throw new Error('bundle manifests must use https');
            }
            const dir = await this.#download(manifestUrl, parsed.version);
            const staged = await this.#shell.stageUpdate(dir);
            if (!staged.ok) {
                throw new Error(staged.error ?? 'the bootstrap refused the bundle');
            }
            this.#log.info(`update ${parsed.version} staged`);
            return this.#set({ state: 'ready', staged: parsed.version, checkedAt: Date.now() });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#log.warn(`update check failed: ${message}`);
            return this.#set({ state: 'error', error: message, checkedAt: Date.now() });
        }
    }

    async #download(manifestUrl: URL, version: string): Promise<string> {
        const check = parseManifest(await this.#getJson(manifestUrl));
        if (!check.ok) {
            throw new Error(check.reason);
        }
        const manifest: BundleManifest = check.manifest;
        if (manifest.version !== version) {
            throw new Error(`feed says ${version} but the manifest is ${manifest.version}`);
        }
        if (!isShellCompatible(this.#shellVersion, manifest.requires.shell)) {
            throw new Error(
                `bundle ${version} needs shell ${manifest.requires.shell}; this install is ${this.#shellVersion}, download the new installer`,
            );
        }
        const dir = path.join(this.#downloadsDir, version);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        let downloaded = 0;
        for (const file of manifest.files) {
            if (!isSafeRelativePath(file.path)) {
                throw new Error(`unsafe path in manifest: ${file.path}`);
            }
            const target = path.join(dir, ...file.path.split('/'));
            mkdirSync(path.dirname(target), { recursive: true });
            const local = path.join(this.#bundleDir, ...file.path.split('/'));
            let bytes: Buffer | undefined;
            if (this.#bundleDir && existsSync(local)) {
                const current = readFileSync(local);
                if (createHash('sha256').update(current).digest('hex') === file.sha256) {
                    bytes = current;
                }
            }
            if (!bytes) {
                const url = new URL(file.path, manifestUrl);
                const response = await this.#fetch(url, { signal: AbortSignal.timeout(120_000) });
                if (!response.ok) {
                    throw new Error(`${url.href}: http ${response.status}`);
                }
                bytes = Buffer.from(await response.arrayBuffer());
                downloaded += bytes.length;
            }
            if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
                throw new Error(`hash mismatch for ${file.path}`);
            }
            writeFileSync(target, bytes);
        }
        writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        this.#log.info(`downloaded bundle ${version}: ${manifest.files.length} files, ${downloaded} bytes fetched`);
        return dir;
    }

    async apply(runningTurns: number): Promise<void> {
        if (!this.#status.staged) {
            throw new Error('no update is ready');
        }
        if (runningTurns > 0) {
            throw new Error('还有任务在运行，等它们完成后再重启更新');
        }
        await this.#shell.restart();
    }

    dispose(): void {
        clearTimeout(this.#timer);
    }
}
