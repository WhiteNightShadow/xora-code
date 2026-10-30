import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type AgentDefinition, agentFiles, loadAgentFile } from './agents.ts';
import {
    type CommandOverrides,
    discoverCommands,
    loadCommandFile,
    parseCommand,
    type SlashCommand,
} from './commands.ts';
import { errorMessage, isDirectory, isFile, isSameOrInside, readText, toPosix } from './fs-utils.ts';
import { isAllowedGitUrl } from './git.ts';
import { type HookConfig, type HookSource, loadHookConfigs, parseHookConfig } from './hooks.ts';
import { findSkillScripts, loadSkill, SKILL_FILE, type Skill, skillDirs } from './skills.ts';
import type { Diagnostic, ExtensionSource } from './types.ts';
import { isPlainObject, substituteDeep } from './values.ts';

/**
 * Claude Code plugins (`.claude-plugin/plugin.json`) and marketplaces (`.claude-plugin/marketplace.json`).
 * Components come from the default locations (`commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json`)
 * or from manifest paths: `commands` and `agents` replace the default, `skills` adds to it, `hooks` and
 * `mcpServers` merge with it. Xora-specific fields live under the manifest's `xora` key.
 */

export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
/** Placeholder for the plugin's install directory in hook commands, MCP configs and markdown bodies. */
export const PLUGIN_ROOT_PLACEHOLDER = '$' + '{CLAUDE_PLUGIN_ROOT}';

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit; usable in a directory name. */
export function isValidPluginName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes('..');
}

const AuthorSchema = z.union([
    z.string().transform((name) => ({ name })),
    z.looseObject({ name: z.string(), email: z.string().optional(), url: z.string().optional() }),
]);

/** `plugin.json`. Only `name` is required; unknown keys, including the component paths, are kept. */
export const PluginManifestSchema = z.looseObject({
    name: z.string().min(1),
    version: z.union([z.string(), z.number().transform(String)]).optional(),
    description: z.string().optional(),
    author: AuthorSchema.optional(),
    homepage: z.string().optional(),
    repository: z.union([z.string(), z.looseObject({ url: z.string() }).transform((value) => value.url)]).optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    /** Xora-specific settings. */
    xora: z.record(z.string(), z.unknown()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** An MCP server entry: `command` (stdio) or `url` (http). Other fields are passed through. */
export interface McpServerConfig {
    readonly type?: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly url?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly [key: string]: unknown;
}

export interface PluginComponents {
    readonly commands: readonly SlashCommand[];
    readonly agents: readonly AgentDefinition[];
    readonly skills: readonly Skill[];
    /** Hook handlers as written; `${CLAUDE_PLUGIN_ROOT}` is filled in when they run (see `runHooks`). */
    readonly hooks: readonly HookConfig[];
    /** With `${CLAUDE_PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_DATA}` when given) filled in. */
    readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

export interface PluginInfo {
    /** Real path of the plugin directory. */
    readonly root: string;
    readonly manifest: PluginManifest;
    /** The `plugin.json`, when the plugin has one. */
    readonly manifestFile?: string;
    readonly components: PluginComponents;
    /** Runnable files shipped with the plugin's skills, relative to the root. */
    readonly skillScripts: readonly string[];
    readonly diagnostics: readonly Diagnostic[];
    /** False when the manifest is unusable (unreadable, no valid name); the components are then empty. */
    readonly ok: boolean;
}

export interface ReadPluginOptions {
    /** Whether the plugin is enabled with confirmed permissions; copied to every component. Default false. */
    readonly trusted?: boolean;
    /** Marketplace entry that serves as the manifest when there is no `plugin.json`. */
    readonly entry?: Readonly<Record<string, unknown>>;
    /** Name when there is neither a `plugin.json` nor an entry; defaults to the directory name. */
    readonly name?: string;
    /** Value for `${CLAUDE_PLUGIN_DATA}` in MCP configs. */
    readonly dataDir?: string;
}

const EMPTY_COMPONENTS: PluginComponents = { commands: [], agents: [], skills: [], hooks: [], mcpServers: {} };

function asList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [value];
}

function stringField(spec: Record<string, unknown>, key: string): string | undefined {
    const value = spec[key];
    return typeof value === 'string' ? value : undefined;
}

/** Reads a plugin directory: manifest, components and diagnostics. Throws only when `dir` is not a directory. */
export async function readPlugin(dir: string, options: ReadPluginOptions = {}): Promise<PluginInfo> {
    const root = await realpath(dir);
    if (!(await isDirectory(root))) {
        throw new Error(`not a plugin directory: ${dir}`);
    }
    const diagnostics: Diagnostic[] = [];
    const fallbackName = options.name ?? path.basename(root);
    const manifestPath = path.join(root, ...PLUGIN_MANIFEST.split('/'));
    const invalid = (manifestFile?: string): PluginInfo => ({
        root,
        manifest: { name: fallbackName },
        ...(manifestFile === undefined ? {} : { manifestFile }),
        components: EMPTY_COMPONENTS,
        skillScripts: [],
        diagnostics,
        ok: false,
    });

    let raw: unknown;
    let manifestFile: string | undefined;
    if (await isFile(manifestPath)) {
        manifestFile = manifestPath;
        try {
            raw = JSON.parse(await readText(manifestPath));
        } catch (error) {
            diagnostics.push({
                severity: 'error',
                message: `cannot read plugin.json: ${errorMessage(error)}`,
                file: manifestPath,
            });
            return invalid(manifestPath);
        }
    } else if (options.entry) {
        raw = options.entry;
    } else {
        raw = { name: fallbackName };
        diagnostics.push({ severity: 'info', message: `no ${PLUGIN_MANIFEST}; named after the directory`, file: root });
    }
    const label = manifestFile ?? root;
    const parsed = PluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            diagnostics.push({
                severity: 'error',
                message: `${issue.path.join('.') || 'manifest'}: ${issue.message}`,
                file: label,
            });
        }
        return invalid(manifestFile);
    }
    const manifest = parsed.data;
    if (!isValidPluginName(manifest.name)) {
        diagnostics.push({
            severity: 'error',
            message: `invalid plugin name "${manifest.name}": use letters, digits, ".", "_" and "-"`,
            file: label,
        });
        return invalid(manifestFile);
    }
    const fromEntry = manifestFile === undefined && options.entry !== undefined;
    const trusted = options.trusted ?? false;
    const source: ExtensionSource = {
        dir: root,
        origin: 'plugin',
        trusted,
        pluginName: manifest.name,
        pluginRoot: root,
    };
    const error = (message: string, file = label): void => {
        diagnostics.push({ severity: 'error', message, file });
    };

    /** A manifest path: relative to the root, starting with `./`, existing, and not escaping the root. */
    const resolvePath = async (value: unknown, key: string): Promise<string | undefined> => {
        if (typeof value !== 'string' || value === '') {
            error(`${key}: expected a relative path`);
            return undefined;
        }
        if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) {
            error(`${key}: path must stay inside the plugin: ${value}`);
            return undefined;
        }
        if (value !== '.' && !value.startsWith('./')) {
            diagnostics.push({
                severity: 'warning',
                message: `${key}: paths should start with "./": ${value}`,
                file: label,
            });
        }
        let real: string;
        try {
            real = await realpath(path.resolve(root, value));
        } catch {
            error(`${key}: path not found: ${value}`);
            return undefined;
        }
        if (!isSameOrInside(root, real)) {
            error(`${key}: path escapes the plugin directory: ${value}`);
            return undefined;
        }
        return real;
    };

    // Commands: the manifest replaces the default `commands/` directory.
    const commands = new Map<string, SlashCommand>();
    const addCommands = (found: readonly SlashCommand[], notes: readonly Diagnostic[]): void => {
        diagnostics.push(...notes);
        for (const command of found) {
            if (commands.has(command.name)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `duplicate command "/${command.name}"`,
                    file: command.file,
                });
            } else {
                commands.set(command.name, command);
            }
        }
    };
    const scanCommands = async (dirPath: string): Promise<void> => {
        const found = await discoverCommands([{ ...source, dir: dirPath }]);
        addCommands(found.commands, found.diagnostics);
    };
    const commandsField = manifest.commands;
    if (commandsField === undefined) {
        await scanCommands(path.join(root, 'commands'));
    } else if (isPlainObject(commandsField)) {
        for (const [name, spec] of Object.entries(commandsField)) {
            if (!isPlainObject(spec)) {
                error(`commands.${name}: expected an object with source or content`);
                continue;
            }
            const tools = spec.allowedTools;
            const description = stringField(spec, 'description');
            const argumentHint = stringField(spec, 'argumentHint');
            const model = stringField(spec, 'model');
            const overrides: CommandOverrides = {
                ...(description === undefined ? {} : { description }),
                ...(argumentHint === undefined ? {} : { argumentHint }),
                ...(model === undefined ? {} : { model }),
                ...(Array.isArray(tools) ? { allowedTools: tools.filter((tool) => typeof tool === 'string') } : {}),
            };
            const content = stringField(spec, 'content');
            if ((spec.source === undefined) === (content === undefined)) {
                error(`commands.${name}: set exactly one of source and content`);
            } else if (content !== undefined) {
                const found = parseCommand(content, { name, file: label, source, overrides });
                addCommands(found.command ? [found.command] : [], found.diagnostics);
            } else {
                const file = await resolvePath(spec.source, `commands.${name}.source`);
                if (file) {
                    const found = await loadCommandFile(file, source, name, overrides);
                    addCommands(found.command ? [found.command] : [], found.diagnostics);
                }
            }
        }
    } else {
        for (const value of asList(commandsField)) {
            const target = await resolvePath(value, 'commands');
            if (target === undefined) {
                continue;
            }
            if (await isDirectory(target)) {
                await scanCommands(target);
            } else if (/\.md$/i.test(target)) {
                const found = await loadCommandFile(target, source);
                addCommands(found.command ? [found.command] : [], found.diagnostics);
            } else {
                error(`commands: expected a .md file or a directory: ${String(value)}`);
            }
        }
    }

    // Agents: the manifest replaces the default `agents/` directory.
    const agentTargets: { file: string; namespace: string[] }[] = [];
    if (manifest.agents === undefined) {
        agentTargets.push(...(await agentFiles(path.join(root, 'agents'))));
    } else {
        for (const value of asList(manifest.agents)) {
            const target = await resolvePath(value, 'agents');
            if (target === undefined) {
                continue;
            }
            if (await isDirectory(target)) {
                agentTargets.push(...(await agentFiles(target)));
            } else if (/\.md$/i.test(target)) {
                agentTargets.push({ file: target, namespace: [] });
            } else {
                error(`agents: expected a .md file: ${String(value)}`);
            }
        }
    }
    const agents = new Map<string, AgentDefinition>();
    for (const { file, namespace } of agentTargets) {
        const found = await loadAgentFile(file, source, namespace);
        diagnostics.push(...found.diagnostics);
        if (found.agent && !agents.has(found.agent.name)) {
            agents.set(found.agent.name, found.agent);
        } else if (found.agent) {
            diagnostics.push({ severity: 'warning', message: `duplicate agent "${found.agent.name}"`, file });
        }
    }

    // Skills: manifest paths add to `skills/`, except for a marketplace entry that lists its skills.
    const skillRoots: string[] = [];
    const listsSkills = manifest.skills !== undefined;
    if (!(fromEntry && listsSkills) && (await isDirectory(path.join(root, 'skills')))) {
        skillRoots.push(path.join(root, 'skills'));
    }
    if (listsSkills) {
        for (const value of asList(manifest.skills)) {
            const target = await resolvePath(value, 'skills');
            if (target !== undefined && (await isDirectory(target))) {
                skillRoots.push(target);
            } else if (target !== undefined) {
                error(`skills: expected a directory: ${String(value)}`);
            }
        }
    }
    if (skillRoots.length === 0 && !listsSkills && (await isFile(path.join(root, SKILL_FILE)))) {
        skillRoots.push(root);
    }
    const skills = new Map<string, Skill>();
    const seenDirs = new Set<string>();
    const skillScripts: string[] = [];
    for (const skillRoot of skillRoots) {
        for (const skillDir of await skillDirs(skillRoot)) {
            const real = await realpath(skillDir);
            if (seenDirs.has(real) || !isSameOrInside(root, real)) {
                continue;
            }
            seenDirs.add(real);
            const found = await loadSkill(real, source);
            diagnostics.push(...found.diagnostics);
            if (!found.skill) {
                continue;
            }
            if (skills.has(found.skill.id)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `duplicate skill "${found.skill.id}"`,
                    file: found.skill.file,
                });
                continue;
            }
            skills.set(found.skill.id, found.skill);
            for (const script of await findSkillScripts(real)) {
                skillScripts.push(toPosix(path.relative(root, path.join(real, ...script.split('/')))));
            }
        }
    }

    // Hooks: `hooks/hooks.json` plus whatever the manifest declares.
    const hooks: HookConfig[] = [];
    const hookFiles = new Set<string>();
    const hookSource = (file: string): HookSource => ({
        path: file,
        origin: 'plugin',
        trusted,
        pluginName: manifest.name,
        pluginRoot: root,
    });
    const loadHooksFile = async (file: string): Promise<void> => {
        if (hookFiles.has(file)) {
            return;
        }
        hookFiles.add(file);
        const loaded = await loadHookConfigs([hookSource(file)]);
        diagnostics.push(...loaded.diagnostics);
        hooks.push(...loaded.configs);
    };
    const defaultHooks = path.join(root, 'hooks', 'hooks.json');
    if (await isFile(defaultHooks)) {
        await loadHooksFile(await realpath(defaultHooks));
    }
    if (manifest.hooks !== undefined) {
        for (const value of asList(manifest.hooks)) {
            if (isPlainObject(value)) {
                const parsedHooks = parseHookConfig(value, hookSource(label));
                diagnostics.push(...parsedHooks.diagnostics);
                hooks.push(parsedHooks.config);
            } else {
                const file = await resolvePath(value, 'hooks');
                if (file !== undefined) {
                    await loadHooksFile(file);
                }
            }
        }
    }

    // MCP servers: `.mcp.json` first, then the manifest; a later name replaces an earlier one.
    const servers = new Map<string, McpServerConfig>();
    const values: Record<string, string> = { CLAUDE_PLUGIN_ROOT: root };
    if (options.dataDir !== undefined) {
        values.CLAUDE_PLUGIN_DATA = options.dataDir;
    }
    const addServers = (value: unknown, file: string): void => {
        const map = isPlainObject(value) && isPlainObject(value.mcpServers) ? value.mcpServers : value;
        if (!isPlainObject(map)) {
            error('mcpServers: expected an object of servers', file);
            return;
        }
        for (const [name, config] of Object.entries(map)) {
            if (!isPlainObject(config) || (typeof config.command !== 'string' && typeof config.url !== 'string')) {
                error(`MCP server "${name}" needs a command or a url`, file);
                continue;
            }
            servers.set(name, substituteDeep(config, values) as McpServerConfig);
        }
    };
    const readJsonFile = async (file: string): Promise<unknown> => {
        try {
            return JSON.parse(await readText(file));
        } catch (caught) {
            error(`cannot read ${path.basename(file)}: ${errorMessage(caught)}`, file);
            return undefined;
        }
    };
    const defaultMcp = path.join(root, '.mcp.json');
    if (await isFile(defaultMcp)) {
        const json = await readJsonFile(defaultMcp);
        if (json !== undefined) {
            addServers(json, defaultMcp);
        }
    }
    if (manifest.mcpServers !== undefined) {
        for (const value of asList(manifest.mcpServers)) {
            if (isPlainObject(value)) {
                addServers(value, label);
            } else if (typeof value === 'string' && /\.(?:mcpb|dxt)$/i.test(value)) {
                diagnostics.push({
                    severity: 'warning',
                    message: `MCP bundles are not supported: ${value}`,
                    file: label,
                });
            } else {
                const file = await resolvePath(value, 'mcpServers');
                const json = file === undefined ? undefined : await readJsonFile(file);
                if (file !== undefined && json !== undefined) {
                    addServers(json, file);
                }
            }
        }
    }

    return {
        root,
        manifest,
        ...(manifestFile === undefined ? {} : { manifestFile }),
        components: {
            commands: [...commands.values()],
            agents: [...agents.values()],
            skills: [...skills.values()],
            hooks,
            mcpServers: Object.fromEntries(servers),
        },
        skillScripts: [...new Set(skillScripts)].sort(),
        diagnostics,
        ok: true,
    };
}

/** What a plugin can run, for the install dialog (09 §3). Paths inside the plugin read `${CLAUDE_PLUGIN_ROOT}`. */
export interface PluginPermissions {
    /** Hook commands as written, with exec-form arguments appended. */
    readonly hookCommands: readonly string[];
    readonly hookUrls: readonly string[];
    /** `command args…` of stdio MCP servers. */
    readonly mcpCommands: readonly string[];
    readonly mcpUrls: readonly string[];
    /** Host names of the hook and MCP URLs. */
    readonly domains: readonly string[];
    /** Runnable files shipped with skills, relative to the plugin root. */
    readonly skillScripts: readonly string[];
}

export const PERMISSION_KEYS = [
    'hookCommands',
    'hookUrls',
    'mcpCommands',
    'mcpUrls',
    'domains',
    'skillScripts',
] as const;

function sortedUnique(values: Iterable<string>): string[] {
    return [...new Set(values)].sort();
}

/** Summarises what `plugin` can run. Stable across versions: install paths are written as the placeholder. */
export function permissionsOf(plugin: PluginInfo): PluginPermissions {
    const unresolve = (text: string): string => text.split(plugin.root).join(PLUGIN_ROOT_PLACEHOLDER);
    const hookCommands: string[] = [];
    const hookUrls: string[] = [];
    for (const config of plugin.components.hooks) {
        for (const group of config.groups) {
            for (const handler of group.hooks) {
                if (handler.type === 'command') {
                    hookCommands.push(unresolve([handler.command, ...(handler.args ?? [])].join(' ')));
                } else {
                    hookUrls.push(handler.url);
                }
            }
        }
    }
    const mcpCommands: string[] = [];
    const mcpUrls: string[] = [];
    for (const server of Object.values(plugin.components.mcpServers)) {
        if (typeof server.command === 'string') {
            const args = Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === 'string') : [];
            mcpCommands.push(unresolve([server.command, ...args].join(' ')));
        }
        if (typeof server.url === 'string') {
            mcpUrls.push(unresolve(server.url));
        }
    }
    const domains: string[] = [];
    for (const url of [...hookUrls, ...mcpUrls]) {
        try {
            domains.push(new URL(url).hostname);
        } catch {
            // Not a URL; it is still listed above.
        }
    }
    return {
        hookCommands: sortedUnique(hookCommands),
        hookUrls: sortedUnique(hookUrls),
        mcpCommands: sortedUnique(mcpCommands),
        mcpUrls: sortedUnique(mcpUrls),
        domains: sortedUnique(domains),
        skillScripts: sortedUnique(plugin.skillScripts),
    };
}

/** Entries of `after` that `before` does not have. */
export function diffPermissions(before: PluginPermissions, after: PluginPermissions): PluginPermissions {
    const added = (key: (typeof PERMISSION_KEYS)[number]): string[] =>
        after[key].filter((value) => !before[key].includes(value));
    return {
        hookCommands: added('hookCommands'),
        hookUrls: added('hookUrls'),
        mcpCommands: added('mcpCommands'),
        mcpUrls: added('mcpUrls'),
        domains: added('domains'),
        skillScripts: added('skillScripts'),
    };
}

/** Whether `after` can run anything `before` could not, so the user has to confirm again (09 §5). */
export function permissionsGrew(before: PluginPermissions, after: PluginPermissions): boolean {
    const added = diffPermissions(before, after);
    return PERMISSION_KEYS.some((key) => added[key].length > 0);
}

/** Where a marketplace entry's plugin comes from, resolved to something `PluginStore.install` understands. */
export type PluginSourceRef =
    | { readonly kind: 'dir'; readonly path: string }
    | {
          readonly kind: 'git';
          readonly url: string;
          readonly ref?: string;
          readonly sha?: string;
          /** Subdirectory of the repository that holds the plugin. */
          readonly path?: string;
      }
    /** npm, archive, command and other sources Xora does not install. */
    | { readonly kind: 'unsupported'; readonly type: string };

export interface MarketplaceOwner {
    readonly name: string;
    readonly email?: string;
    readonly url?: string;
}

export interface MarketplaceEntry {
    readonly name: string;
    readonly source: PluginSourceRef;
    readonly description?: string;
    readonly version?: string;
    readonly category?: string;
    readonly tags?: readonly string[];
    readonly keywords?: readonly string[];
    /** Default true: the plugin's own `plugin.json` is the authority for its components. */
    readonly strict: boolean;
    /** The entry as written; it is the manifest of a plugin that has no `plugin.json`. */
    readonly entry: Readonly<Record<string, unknown>>;
}

export interface Marketplace {
    readonly name: string;
    readonly owner?: MarketplaceOwner;
    readonly description?: string;
    readonly version?: string;
    /** The directory that holds `.claude-plugin/`; relative sources resolve from it. */
    readonly root: string;
    readonly file: string;
    readonly plugins: readonly MarketplaceEntry[];
    readonly diagnostics: readonly Diagnostic[];
}

function stringList(value: unknown): string[] | undefined {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function githubUrl(repo: string): string {
    return `https://github.com/${repo.replace(/\.git$/, '')}.git`;
}

/**
 * Reads a marketplace from its root directory or from the `marketplace.json` file. Throws when the file is
 * missing or is not a marketplace (no name or no plugin list); problems with single entries are diagnostics and
 * those entries are left out.
 */
export async function readMarketplace(dirOrFile: string): Promise<Marketplace> {
    const info = await stat(dirOrFile);
    let file: string;
    let root: string;
    if (info.isDirectory()) {
        root = await realpath(dirOrFile);
        file = path.join(root, ...MARKETPLACE_MANIFEST.split('/'));
    } else {
        file = await realpath(dirOrFile);
        const parent = path.dirname(file);
        root = path.basename(parent) === '.claude-plugin' ? path.dirname(parent) : parent;
    }
    let json: unknown;
    try {
        json = JSON.parse(await readText(file));
    } catch (error) {
        throw new Error(`cannot read marketplace ${file}: ${errorMessage(error)}`);
    }
    if (!isPlainObject(json) || typeof json.name !== 'string' || !Array.isArray(json.plugins)) {
        throw new Error(`not a marketplace (needs "name" and "plugins"): ${file}`);
    }
    if (!isValidPluginName(json.name)) {
        throw new Error(`invalid marketplace name "${json.name}": ${file}`);
    }
    const diagnostics: Diagnostic[] = [];
    const warn = (message: string): void => {
        diagnostics.push({ severity: 'warning', message, file });
    };
    const fail = (message: string): void => {
        diagnostics.push({ severity: 'error', message, file });
    };
    const metadata = isPlainObject(json.metadata) ? json.metadata : {};
    let owner: MarketplaceOwner | undefined;
    if (isPlainObject(json.owner) && typeof json.owner.name === 'string') {
        const email = json.owner.email;
        const url = json.owner.url;
        owner = {
            name: json.owner.name,
            ...(typeof email === 'string' ? { email } : {}),
            ...(typeof url === 'string' ? { url } : {}),
        };
    } else {
        warn('owner with a name is missing');
    }
    const description = typeof json.description === 'string' ? json.description : metadata.description;
    const version = typeof json.version === 'string' ? json.version : metadata.version;
    let pluginRoot: string | undefined;
    if (typeof metadata.pluginRoot === 'string') {
        const resolved = path.resolve(root, metadata.pluginRoot);
        if (isSameOrInside(root, resolved)) {
            pluginRoot = resolved;
        } else {
            fail(`metadata.pluginRoot must stay inside the marketplace: ${metadata.pluginRoot}`);
        }
    }

    const resolveSource = (value: unknown, where: string): PluginSourceRef | undefined => {
        if (typeof value === 'string') {
            if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) {
                fail(`${where}: path must stay inside the marketplace: ${value}`);
                return undefined;
            }
            if (value === '.' || value === './' || value.startsWith('./')) {
                return { kind: 'dir', path: path.resolve(root, value) };
            }
            if (pluginRoot !== undefined && !/[\\/]/.test(value)) {
                return { kind: 'dir', path: path.resolve(pluginRoot, value) };
            }
            warn(`${where}: relative paths should start with "./": ${value}`);
            return { kind: 'dir', path: path.resolve(root, value) };
        }
        if (!isPlainObject(value)) {
            fail(`${where}: expected a path or a source object`);
            return undefined;
        }
        const ref = typeof value.ref === 'string' ? value.ref : undefined;
        const sha = typeof value.sha === 'string' ? value.sha : undefined;
        const pin = { ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) };
        const type = value.source;
        if (type === 'github') {
            if (typeof value.repo !== 'string' || !GITHUB_REPO.test(value.repo)) {
                fail(`${where}: github source needs repo "owner/name"`);
                return undefined;
            }
            return { kind: 'git', url: githubUrl(value.repo), ...pin };
        }
        if (type === 'url' || type === 'git' || type === 'git-subdir') {
            const raw = typeof value.url === 'string' ? value.url : undefined;
            const url = raw !== undefined && type === 'git-subdir' && GITHUB_REPO.test(raw) ? githubUrl(raw) : raw;
            if (url === undefined || !isAllowedGitUrl(url)) {
                fail(`${where}: ${String(type)} source needs a git url`);
                return undefined;
            }
            if (type !== 'git-subdir') {
                return { kind: 'git', url, ...pin };
            }
            const subdir = value.path;
            if (typeof subdir !== 'string' || path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes('..')) {
                fail(`${where}: git-subdir source needs a relative path`);
                return undefined;
            }
            return { kind: 'git', url, path: subdir, ...pin };
        }
        warn(`${where}: ${String(type)} sources are not supported`);
        return { kind: 'unsupported', type: String(type) };
    };

    const plugins: MarketplaceEntry[] = [];
    const names = new Set<string>();
    for (const [index, entry] of json.plugins.entries()) {
        const where = `plugins[${index}]`;
        if (!isPlainObject(entry) || typeof entry.name !== 'string') {
            fail(`${where}: needs a name`);
            continue;
        }
        if (!isValidPluginName(entry.name)) {
            fail(`${where}: invalid plugin name "${entry.name}"`);
            continue;
        }
        if (names.has(entry.name)) {
            fail(`${where}: duplicate plugin name "${entry.name}"`);
            continue;
        }
        const source = resolveSource(entry.source, `${where}.source`);
        if (!source) {
            continue;
        }
        names.add(entry.name);
        const tags = stringList(entry.tags);
        const keywords = stringList(entry.keywords);
        plugins.push({
            name: entry.name,
            source,
            ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
            ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
            ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
            ...(tags === undefined ? {} : { tags }),
            ...(keywords === undefined ? {} : { keywords }),
            strict: entry.strict !== false,
            entry,
        });
    }
    return {
        name: json.name,
        ...(owner === undefined ? {} : { owner }),
        ...(typeof description === 'string' ? { description } : {}),
        ...(typeof version === 'string' ? { version } : {}),
        root,
        file,
        plugins,
        diagnostics,
    };
}
