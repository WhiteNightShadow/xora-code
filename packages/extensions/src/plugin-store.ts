import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
    copyTree,
    errorCode,
    errorMessage,
    hashDirectory,
    isDirectory,
    isSameOrInside,
    listDir,
    writeJsonAtomic,
} from './fs-utils.ts';
import { defaultGitEnv, gitClone, redactUrl } from './git.ts';
import {
    diffPermissions,
    type PluginInfo,
    type PluginPermissions,
    permissionsGrew,
    permissionsOf,
    readPlugin,
} from './plugins.ts';
import type { Diagnostic } from './types.ts';

/**
 * Installed plugins under one root, e.g. `<data>/extensions/plugins` (09 §3): each version in
 * `<root>/<name>@<version>`, the previous version kept for rollback, and an index in `installed.json`.
 * Installing fetches into a staging directory, validates, hashes and then renames into place, so a half-installed
 * plugin is never visible. New installs start disabled until the host has shown the permissions and the user
 * confirmed; an update whose permissions grew is disabled again (09 §5).
 */

export const INDEX_FILE = 'installed.json';
/** Copy limits for a plugin tree. */
export const MAX_PLUGIN_FILES = 20_000;
export const MAX_PLUGIN_BYTES = 256 * 1024 * 1024;

export type PluginInstallSource =
    | { readonly kind: 'dir'; readonly path: string }
    | {
          readonly kind: 'git';
          readonly url: string;
          /** Branch or tag. */
          readonly ref?: string;
          /** Full commit to pin. */
          readonly sha?: string;
          /** Subdirectory of the repository that holds the plugin. */
          readonly path?: string;
      };

const Strings = z.array(z.string()).readonly();

const PermissionsSchema = z.object({
    hookCommands: Strings,
    hookUrls: Strings,
    mcpCommands: Strings,
    mcpUrls: Strings,
    domains: Strings,
    skillScripts: Strings,
});

const SourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dir'), path: z.string() }),
    z.object({
        kind: z.literal('git'),
        url: z.string(),
        ref: z.string().optional(),
        sha: z.string().optional(),
        path: z.string().optional(),
        /** The commit that was installed. */
        commit: z.string().optional(),
    }),
]);

const VersionSchema = z.object({
    version: z.string(),
    hash: z.string(),
    source: SourceSchema,
    enabled: z.boolean(),
    installedAt: z.string(),
    permissions: PermissionsSchema,
    /** Marketplace entry used as the manifest, for plugins without `plugin.json`. */
    entry: z.record(z.string(), z.unknown()).optional(),
});

const StoredPluginSchema = VersionSchema.extend({
    name: z.string(),
    /** A pinned plugin is not updated to another version. */
    pinned: z.boolean().default(false),
    previous: VersionSchema.optional(),
});

const IndexSchema = z.object({ schemaVersion: z.literal(1), plugins: z.array(StoredPluginSchema) });

type Index = z.infer<typeof IndexSchema>;
type StoredPlugin = z.infer<typeof StoredPluginSchema>;
export type InstalledSource = z.infer<typeof SourceSchema>;
export type InstalledVersion = z.infer<typeof VersionSchema>;

export interface InstalledPlugin extends StoredPlugin {
    /** Directory of the current version. */
    readonly dir: string;
}

export interface InstallOptions {
    /** Refuse a plugin whose manifest name differs, e.g. the marketplace entry name. */
    readonly expectedName?: string;
    /** Marketplace entry, the manifest of a plugin that has no `plugin.json`. */
    readonly entry?: Readonly<Record<string, unknown>>;
    /** Enable right away, because the user already confirmed. Default: keep the previous state, off for new plugins. */
    readonly enable?: boolean;
    readonly signal?: AbortSignal;
}

export interface InstallResult {
    readonly plugin: InstalledPlugin;
    readonly status: 'installed' | 'updated' | 'unchanged';
    readonly previousVersion?: string;
    readonly permissions: PluginPermissions;
    /** The update can run something the previous version could not; ask the user again. */
    readonly permissionsGrew: boolean;
    readonly addedPermissions: PluginPermissions;
    readonly diagnostics: readonly Diagnostic[];
}

export class PluginInstallError extends Error {
    readonly diagnostics: readonly Diagnostic[];

    constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
        super(message);
        this.name = 'PluginInstallError';
        this.diagnostics = diagnostics;
    }
}

export interface PluginStoreOptions {
    readonly root: string;
    /** Environment for `git`; default {@link defaultGitEnv}. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** The git executable. Default `git`. */
    readonly git?: string;
    readonly gitTimeoutMs?: number;
    readonly now?: () => Date;
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function dirName(name: string, version: string): string {
    return `${name}@${version}`;
}

function versionOf(plugin: InstalledVersion): InstalledVersion {
    const { version, hash, source, enabled, installedAt, permissions, entry } = plugin;
    return { version, hash, source, enabled, installedAt, permissions, ...(entry ? { entry } : {}) };
}

export class PluginStore {
    readonly root: string;
    readonly #env: Readonly<Record<string, string | undefined>>;
    readonly #git: string | undefined;
    readonly #gitTimeoutMs: number | undefined;
    readonly #now: () => Date;
    #queue: Promise<unknown> = Promise.resolve();

    constructor(options: PluginStoreOptions) {
        this.root = path.resolve(options.root);
        this.#env = options.env ?? defaultGitEnv();
        this.#git = options.git;
        this.#gitTimeoutMs = options.gitTimeoutMs;
        this.#now = options.now ?? (() => new Date());
    }

    async list(): Promise<InstalledPlugin[]> {
        return (await this.#load()).plugins.map((plugin) => this.#withDir(plugin));
    }

    async get(name: string): Promise<InstalledPlugin | undefined> {
        const plugin = (await this.#load()).plugins.find((item) => item.name === name);
        return plugin && this.#withDir(plugin);
    }

    /** Fetches, validates and installs a plugin, or updates it to the fetched version. */
    install(source: PluginInstallSource, options: InstallOptions = {}): Promise<InstallResult> {
        return this.#serialize(() => this.#install(source, options));
    }

    enable(name: string, on: boolean): Promise<InstalledPlugin> {
        return this.#update(name, (plugin) => ({ ...plugin, enabled: on }));
    }

    /** Pins the plugin to its current version: installing another version fails until it is unpinned. */
    pin(name: string, on: boolean): Promise<InstalledPlugin> {
        return this.#update(name, (plugin) => ({ ...plugin, pinned: on }));
    }

    /** Switches to the kept previous version; the current one becomes the previous, so this can be undone. */
    rollback(name: string): Promise<InstalledPlugin> {
        return this.#update(name, (plugin) => {
            if (!plugin.previous) {
                throw new PluginInstallError(`no previous version of ${name} to roll back to`);
            }
            return { ...plugin.previous, name: plugin.name, pinned: plugin.pinned, previous: versionOf(plugin) };
        });
    }

    /** Removes the plugin and its kept previous version. Returns false when it was not installed. */
    uninstall(name: string): Promise<boolean> {
        return this.#serialize(async () => {
            const index = await this.#load();
            const plugin = index.plugins.find((item) => item.name === name);
            if (!plugin) {
                return false;
            }
            await this.#save({ ...index, plugins: index.plugins.filter((item) => item !== plugin) });
            await rm(this.#dirOf(name, plugin.version), { recursive: true, force: true });
            if (plugin.previous) {
                await rm(this.#dirOf(name, plugin.previous.version), { recursive: true, force: true });
            }
            return true;
        });
    }

    /** Reads the current version; its components are trusted when the plugin is enabled. */
    async read(name: string): Promise<PluginInfo> {
        const plugin = await this.get(name);
        if (!plugin) {
            throw new PluginInstallError(`plugin ${name} is not installed`);
        }
        return readPlugin(plugin.dir, { trusted: plugin.enabled, ...(plugin.entry ? { entry: plugin.entry } : {}) });
    }

    /** Every enabled plugin, read; plugins that cannot be read are skipped. */
    async loadEnabled(): Promise<PluginInfo[]> {
        const plugins: PluginInfo[] = [];
        for (const plugin of await this.list()) {
            if (!plugin.enabled) {
                continue;
            }
            try {
                plugins.push(
                    await readPlugin(plugin.dir, { trusted: true, ...(plugin.entry ? { entry: plugin.entry } : {}) }),
                );
            } catch {
                // Removed behind our back; `list()` still shows it so the host can offer to reinstall.
            }
        }
        return plugins;
    }

    #dirOf(name: string, version: string): string {
        return path.join(this.root, dirName(name, version));
    }

    #withDir(plugin: StoredPlugin): InstalledPlugin {
        return { ...plugin, dir: this.#dirOf(plugin.name, plugin.version) };
    }

    #serialize<T>(task: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }

    #update(name: string, change: (plugin: StoredPlugin) => StoredPlugin): Promise<InstalledPlugin> {
        return this.#serialize(async () => {
            const index = await this.#load();
            const plugin = index.plugins.find((item) => item.name === name);
            if (!plugin) {
                throw new PluginInstallError(`plugin ${name} is not installed`);
            }
            const next = change(plugin);
            await this.#save({ ...index, plugins: index.plugins.map((item) => (item === plugin ? next : item)) });
            return this.#withDir(next);
        });
    }

    async #load(): Promise<Index> {
        const file = path.join(this.root, INDEX_FILE);
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            if (errorCode(error) === 'ENOENT') {
                return { schemaVersion: 1, plugins: [] };
            }
            throw error;
        }
        try {
            return IndexSchema.parse(JSON.parse(text));
        } catch {
            // Plugins on disk stay; without the index they count as not installed and disabled.
            await rename(file, `${file}.corrupt-${Date.now()}`);
            return { schemaVersion: 1, plugins: [] };
        }
    }

    async #save(index: Index): Promise<void> {
        const plugins = [...index.plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        await writeJsonAtomic(path.join(this.root, INDEX_FILE), { ...index, plugins });
    }

    async #fetch(
        source: PluginInstallSource,
        staging: string,
        warn: (message: string) => void,
        signal: AbortSignal | undefined,
    ): Promise<{ dir: string; source: InstalledSource }> {
        const target = path.join(staging, 'plugin');
        const limits = { maxFiles: MAX_PLUGIN_FILES, maxBytes: MAX_PLUGIN_BYTES };
        if (source.kind === 'dir') {
            let from: string;
            try {
                from = await realpath(source.path);
            } catch {
                throw new PluginInstallError(`source directory does not exist: ${source.path}`);
            }
            if (!(await isDirectory(from))) {
                throw new PluginInstallError(`source is not a directory: ${source.path}`);
            }
            if (isSameOrInside(await realpath(this.root), from)) {
                throw new PluginInstallError('cannot install from inside the plugin store');
            }
            await copyTree(from, target, limits, warn);
            return { dir: target, source: { kind: 'dir', path: from } };
        }
        const repo = path.join(staging, 'repo');
        const { commit } = await gitClone({
            url: source.url,
            dest: repo,
            env: this.#env,
            ...(source.ref === undefined ? {} : { ref: source.ref }),
            ...(source.sha === undefined ? {} : { sha: source.sha }),
            ...(this.#git === undefined ? {} : { git: this.#git }),
            ...(this.#gitTimeoutMs === undefined ? {} : { timeoutMs: this.#gitTimeoutMs }),
            ...(signal ? { signal } : {}),
        });
        let from = repo;
        if (source.path !== undefined) {
            if (path.isAbsolute(source.path) || source.path.split(/[\\/]/).includes('..')) {
                throw new PluginInstallError(`invalid path in repository: ${source.path}`);
            }
            from = path.resolve(repo, source.path);
            if (!(await isDirectory(from)) || !isSameOrInside(repo, await realpath(from))) {
                throw new PluginInstallError(`no directory ${source.path} in the repository`);
            }
        }
        await copyTree(from, target, limits, warn);
        return {
            dir: target,
            source: {
                kind: 'git',
                url: redactUrl(source.url),
                ...(source.ref === undefined ? {} : { ref: source.ref }),
                ...(source.sha === undefined ? {} : { sha: source.sha }),
                ...(source.path === undefined ? {} : { path: source.path }),
                commit,
            },
        };
    }

    async #install(source: PluginInstallSource, options: InstallOptions): Promise<InstallResult> {
        await mkdir(this.root, { recursive: true });
        // Left over from an interrupted install; installs are serialised, so none is in use.
        for (const entry of await listDir(this.root)) {
            if (entry.name.startsWith('.staging-')) {
                await rm(path.join(this.root, entry.name), { recursive: true, force: true });
            }
        }
        const staging = path.join(this.root, `.staging-${randomUUID()}`);
        const diagnostics: Diagnostic[] = [];
        try {
            await mkdir(staging);
            const fetched = await this.#fetch(
                source,
                staging,
                (message) => diagnostics.push({ severity: 'warning', message }),
                options.signal,
            );
            const info = await readPlugin(fetched.dir, {
                ...(options.entry ? { entry: options.entry } : {}),
                ...(options.expectedName === undefined ? {} : { name: options.expectedName }),
            });
            diagnostics.push(...info.diagnostics);
            if (!info.ok) {
                throw new PluginInstallError('not a valid plugin', diagnostics);
            }
            const name = info.manifest.name;
            if (options.expectedName !== undefined && name !== options.expectedName) {
                throw new PluginInstallError(`expected plugin ${options.expectedName}, got ${name}`, diagnostics);
            }
            const hash = await hashDirectory(fetched.dir);
            const version = info.manifest.version ?? `0.0.0-${hash.slice(0, 12)}`;
            if (!VERSION.test(version)) {
                throw new PluginInstallError(`unusable version "${version}"`, diagnostics);
            }
            const permissions = permissionsOf(info);
            const index = await this.#load();
            const existing = index.plugins.find((item) => item.name === name);
            // Directory names must not collide on case-insensitive file systems (macOS, Windows).
            const clash = index.plugins.find(
                (item) => item.name !== name && item.name.toLowerCase() === name.toLowerCase(),
            );
            if (clash) {
                throw new PluginInstallError(`${name} clashes with the installed plugin ${clash.name}`, diagnostics);
            }
            if (existing && existing.version === version) {
                if (existing.hash !== hash) {
                    throw new PluginInstallError(
                        `${name}@${version} is installed with different content; change the version or uninstall first`,
                        diagnostics,
                    );
                }
                let current = existing;
                if (options.enable !== undefined && options.enable !== existing.enabled) {
                    current = { ...existing, enabled: options.enable };
                    await this.#save({
                        ...index,
                        plugins: index.plugins.map((item) => (item === existing ? current : item)),
                    });
                }
                return {
                    plugin: this.#withDir(current),
                    status: 'unchanged',
                    permissions: existing.permissions,
                    permissionsGrew: false,
                    addedPermissions: diffPermissions(existing.permissions, existing.permissions),
                    diagnostics,
                };
            }
            if (existing?.pinned) {
                throw new PluginInstallError(`${name} is pinned to ${existing.version}`, diagnostics);
            }
            const grew = existing ? permissionsGrew(existing.permissions, permissions) : false;
            const target = this.#dirOf(name, version);
            // A directory left for this version, e.g. the kept previous version being installed again.
            await rm(target, { recursive: true, force: true });
            await rename(fetched.dir, target);
            const record: StoredPlugin = {
                name,
                version,
                hash,
                source: fetched.source,
                enabled: options.enable ?? (existing ? existing.enabled && !grew : false),
                installedAt: this.#now().toISOString(),
                permissions,
                ...(options.entry && !info.manifestFile ? { entry: { ...options.entry } } : {}),
                pinned: existing?.pinned ?? false,
                ...(existing ? { previous: versionOf(existing) } : {}),
            };
            const plugins = existing
                ? index.plugins.map((item) => (item === existing ? record : item))
                : [...index.plugins, record];
            await this.#save({ ...index, plugins });
            // Only one previous version is kept.
            const dropped = existing?.previous?.version;
            if (dropped !== undefined && dropped !== version && dropped !== existing?.version) {
                await rm(this.#dirOf(name, dropped), { recursive: true, force: true });
            }
            return {
                plugin: this.#withDir(record),
                status: existing ? 'updated' : 'installed',
                ...(existing ? { previousVersion: existing.version } : {}),
                permissions,
                permissionsGrew: grew,
                addedPermissions: existing ? diffPermissions(existing.permissions, permissions) : permissions,
                diagnostics,
            };
        } catch (error) {
            if (error instanceof PluginInstallError) {
                throw error;
            }
            throw new PluginInstallError(`install failed: ${redactUrl(errorMessage(error))}`, diagnostics);
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
    }
}
