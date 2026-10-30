import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
    type AgentDefinition,
    type Diagnostic,
    defaultGitEnv,
    discoverAgents,
    discoverCommands,
    discoverSkills,
    type ExtensionOrigin,
    effectiveTrust,
    expandCommand,
    findCommand,
    gitClone,
    type HookConfig,
    type HookEvent,
    type HooksOutcome,
    type InstalledPlugin,
    loadHookConfigs,
    type Marketplace,
    type MatchedHook,
    matchHooks,
    type PluginInfo,
    type PluginPermissions,
    PluginStore,
    parseSlashInput,
    readMarketplace,
    readSkill,
    runHooks,
    type Skill,
    type SlashCommand,
} from '@xora/extensions';
import {
    type AcpMcpCapabilities,
    type AcpMcpServer,
    authHeaders,
    authorize,
    importServers,
    McpConnection,
    type McpSecretStorage,
    type McpServerConfig,
    normalizeServerName,
    parseServerConfig,
    safeBaseEnv,
    toAcpMcpServers,
} from '@xora/mcp';
import { type ExtensionsSnapshot, type Project, RpcError, RpcErrorCode } from '@xora/protocol';
import { sanitizeEnv } from '@xora/tools';
import { z } from 'zod';
import type { Bus } from './bus.ts';
import type { HostToolResult } from './engines/manager.ts';
import type { Logger } from './log.ts';
import type { ProjectService } from './projects.ts';
import type { ShellApi } from './shell.ts';

/**
 * Skills, slash commands, agent definitions, hooks, MCP servers and plugins (09): discovery, trust, the settings
 * page, and what a session gets from them. Layout under `<data>/extensions`: `skills/`, `commands/`, `agents/`,
 * `hooks.json`, `plugins/`, and `state.json` (switches and MCP servers; their secrets live in the secret store).
 */

export type ToolHookEvent = 'PreToolUse' | 'PostToolUse';

export interface ExtensionDeps {
    readonly dir: string;
    readonly projects: ProjectService;
    readonly shell: ShellApi;
    readonly bus: Bus;
    readonly log: Logger;
    /** Home directory for `~/.agents/skills` and config imports; tests point it at a temporary folder. */
    readonly home?: string;
    /** Environment for hook commands; secrets are removed before use. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

const StoredServerSchema = z.object({
    name: z.string(),
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    /** Names only; the values are in the secret store under {@link secretKeyOf}. */
    envKeys: z.array(z.string()).default([]),
    headerKeys: z.array(z.string()).default([]),
    origin: z.enum(['global', 'project', 'imported']),
    importedFrom: z.string().optional(),
    /** Secrets the import could not copy; the user has to fill them in. */
    missingSecrets: z.array(z.string()).optional(),
});
type StoredServer = z.infer<typeof StoredServerSchema>;

const MarketSourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dir'), path: z.string() }),
    z.object({ kind: z.literal('git'), url: z.string(), ref: z.string().optional() }),
]);
type MarketSource = z.infer<typeof MarketSourceSchema>;

const StateSchema = z.object({
    schemaVersion: z.literal(1),
    disabledSkills: z.array(z.string()).default([]),
    disabledMcp: z.array(z.string()).default([]),
    servers: z.array(StoredServerSchema).default([]),
    projectServers: z.record(z.string(), z.array(StoredServerSchema)).default({}),
    /** Plugin marketplaces (09 §3): a git repository (cloned under `markets/`) or a local folder. */
    markets: z.array(z.object({ name: z.string(), source: MarketSourceSchema, addedAt: z.number() })).default([]),
});
type State = z.infer<typeof StateSchema>;

const EMPTY_STATE: State = {
    schemaVersion: 1,
    disabledSkills: [],
    disabledMcp: [],
    servers: [],
    projectServers: {},
    markets: [],
};
const MARKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One MCP server as a session would get it, before secrets are filled in. */
interface McpEntry {
    /** `global:<name>`, `project:<projectId>:<name>`, `repo:<projectId>:<name>` or `plugin:<plugin>:<name>`. */
    readonly key: string;
    readonly config: McpServerConfig;
    readonly secretKey?: string;
    readonly source: string;
    readonly missingSecrets?: readonly string[];
}

export interface LoadedExtensions {
    readonly project: Project | undefined;
    readonly trusted: boolean;
    readonly skills: readonly Skill[];
    readonly commands: readonly SlashCommand[];
    readonly agents: readonly AgentDefinition[];
    readonly hooks: readonly HookConfig[];
    readonly mcp: readonly McpEntry[];
    readonly plugins: ReadonlyArray<{ readonly installed: InstalledPlugin; readonly info?: PluginInfo }>;
    readonly diagnostics: readonly string[];
    readonly disabledSkills: ReadonlySet<string>;
    readonly disabledMcp: ReadonlySet<string>;
}

/** What a session gets from the extensions of its project. */
export interface SessionExtras {
    readonly loaded: LoadedExtensions;
    readonly skills: readonly Skill[];
    readonly layers: ReadonlyArray<{ id: string; title: string; text: string }>;
    readonly tools: ReadonlyArray<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        kind: 'read';
    }>;
    /** Enabled, trusted MCP servers with their secrets; see {@link ExtensionService.mcpServersFor}. */
    readonly mcpConfigs: readonly McpServerConfig[];
    readonly hookEvents: readonly ToolHookEvent[];
}

/** What the engine gets back from the tool hooks (see the engine's `HookReply`). */
export interface ToolHookReply {
    blocked?: boolean;
    reason?: string;
    decision?: 'allow' | 'ask' | 'deny';
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
}

export const SKILL_TOOL = 'skill';

/**
 * Built-in skills, written under `<extensions>/builtin/skills` at start-up. `extension-creator` is how extensions
 * are made from a conversation (09 §3): the agent drafts the files and saves them with the write tool, so the user
 * reviews every file in an approval card first.
 */
function builtinSkills(userDir: string): Record<string, string> {
    return {
        'extension-creator': `---
name: extension-creator
description: Create Xora Code extensions from a conversation - skills, slash commands and agent definitions. Use when the user asks to make, add or change a skill, a /command or a custom agent.
---

# Creating extensions

Xora Code reads extensions from files. Draft them with the user, then save them with the write tool; the user reviews every file in an approval card before it is written.

## Where files go

Ask whether the extension is for this project only or for all projects, unless the user already said.

- Project (lives in the repository): \`.xora/skills/<name>/SKILL.md\`, \`.xora/commands/<name>.md\`, \`.xora/agents/<name>.md\` under the project root.
- User (all projects, never committed): \`${userDir}/skills/<name>/SKILL.md\`, \`${userDir}/commands/<name>.md\`, \`${userDir}/agents/<name>.md\`.

Names use lowercase letters, digits and hyphens, at most 64 characters. A skill's folder name must equal its \`name\`.

## Skills

A folder with a \`SKILL.md\`:

\`\`\`markdown
---
name: <name>
description: <what it does and when to use it; one or two sentences, at most 1024 characters>
---

# <Title>

<Instructions to follow, step by step. Keep this file short: put long references, examples and scripts in other files of the folder and say when to read or run them.>
\`\`\`

The description decides when the skill is picked, so name the tasks and words that should trigger it.

## Slash commands

A markdown file; \`/<name> <arguments>\` sends its body as the prompt:

\`\`\`markdown
---
description: <shown in the command list>
argument-hint: <for example: <file> [focus]>
---
<Prompt text. $ARGUMENTS is everything after the command; $1, $2 and so on are single arguments.>
\`\`\`

## Agent definitions

A markdown file that agent teams can use:

\`\`\`markdown
---
name: <name>
description: <what this agent is for>
tools: <optional, comma-separated tool names>
tier: <optional: flagship, standard, economy or fast>
role: <optional: planner, scout, executor, reviewer or expert>
---
<The agent's instructions.>
\`\`\`

## Steps

1. Ask only what you need: the purpose, the scope (project or user) and, for commands, the arguments.
2. Show a short draft in your reply, then write the files.
3. Never put secrets (keys, tokens, passwords) into extension files.
4. After saving, tell the user that the extension shows up under Settings → Extensions and how to use it.
`,
    };
}
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Tool names as Claude Code calls them, so that hook matchers written for it (`Bash`, `Edit|Write`) work. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
    bash: 'Bash',
    bash_output: 'BashOutput',
    bash_kill: 'KillShell',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    multi_edit: 'MultiEdit',
    apply_patch: 'ApplyPatch',
    glob: 'Glob',
    grep: 'Grep',
    list: 'LS',
    todo: 'TodoWrite',
    fetch: 'WebFetch',
    web_search: 'WebSearch',
};

/** Input fields under their Claude Code names, for hook scripts that read `tool_input.file_path`. */
const INPUT_ALIASES: ReadonlyArray<readonly [string, string]> = [
    ['path', 'file_path'],
    ['oldString', 'old_string'],
    ['newString', 'new_string'],
    ['replaceAll', 'replace_all'],
];

function message(diagnostic: Diagnostic): string {
    return diagnostic.file ? `${diagnostic.file}：${diagnostic.message}` : diagnostic.message;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function secretKeyOf(scope: string, name: string): string {
    return `mcp:${scope}:${name}`;
}

function targetOf(config: McpServerConfig): string {
    return config.transport === 'stdio' ? [config.command, ...config.args].join(' ') : config.url;
}

function permissionLines(permissions: PluginPermissions): string[] {
    return [
        ...permissions.hookCommands.map((value) => `hook命令：${value}`),
        ...permissions.hookUrls.map((value) => `hook地址：${value}`),
        ...permissions.mcpCommands.map((value) => `mcp命令：${value}`),
        ...permissions.mcpUrls.map((value) => `mcp地址：${value}`),
        ...permissions.domains.map((value) => `访问域名：${value}`),
        ...permissions.skillScripts.map((value) => `skill脚本：${value}`),
    ];
}

function skillIndex(skills: readonly Skill[]): string {
    const lines = skills.map((skill) => {
        const note = effectiveTrust(skill.origin, skill.trusted).runSkillScripts
            ? ''
            : ' [from an untrusted project: read only, do not run its scripts]';
        return `- ${skill.id}: ${skill.description.replace(/\s+/g, ' ').trim()}${note}`;
    });
    return [
        `Skills are folders of instructions and resources. When a task matches a skill, load it with the ${SKILL_TOOL} tool first and follow it.`,
        ...lines,
    ].join('\n');
}

/** Parses the `mcpServers` of a Claude-style `.mcp.json` in a repository. */
function repoServers(json: unknown, trusted: boolean): { configs: McpServerConfig[]; problems: string[] } {
    const servers = (json as { mcpServers?: unknown } | null)?.mcpServers;
    const configs: McpServerConfig[] = [];
    const problems: string[] = [];
    if (!servers || typeof servers !== 'object') {
        return { configs, problems };
    }
    for (const [raw, value] of Object.entries(servers as Record<string, unknown>)) {
        const entry = (value ?? {}) as Record<string, unknown>;
        const type = typeof entry.type === 'string' ? entry.type : typeof entry.url === 'string' ? 'http' : 'stdio';
        const transport = type === 'streamable-http' || type === 'streamableHttp' ? 'http' : type;
        const checked = parseServerConfig({
            name: normalizeServerName(raw),
            transport,
            enabled: true,
            origin: 'project',
            trusted,
            ...(transport === 'stdio'
                ? { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} }
                : { url: entry.url, headers: entry.headers ?? {} }),
        });
        if (checked.ok) configs.push(checked.config);
        else problems.push(checked.reason);
    }
    return { configs, problems };
}

async function readJson(file: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

export class ExtensionService {
    readonly plugins: PluginStore;
    readonly #deps: ExtensionDeps;
    readonly #home: string;
    readonly #stateFile: string;
    readonly #tested = new Map<
        string,
        { ok: boolean; tools: number; error?: string; needsAuth?: boolean; at: number }
    >();
    /** What the engine last reported per `<projectId>:<server>`; the newer of this and a test is shown. */
    readonly #live = new Map<string, { status: string; tools: number; error?: string; at: number }>();
    #state: State | undefined;
    #writing: Promise<void> = Promise.resolve();
    #builtins: Promise<void> | undefined;

    constructor(deps: ExtensionDeps) {
        this.#deps = deps;
        this.#home = deps.home ?? homedir();
        this.#stateFile = path.join(deps.dir, 'state.json');
        this.plugins = new PluginStore({ root: path.join(deps.dir, 'plugins') });
    }

    get #storage(): McpSecretStorage {
        const { shell } = this.#deps;
        return {
            get: async (key) => (await shell.getSecret(key)) ?? undefined,
            set: (key, value) => shell.setSecret(key, value),
            delete: (key) => shell.deleteSecret(key),
        };
    }

    async #readState(): Promise<State> {
        if (!this.#state) {
            try {
                const json = await readJson(this.#stateFile);
                this.#state = json === undefined ? EMPTY_STATE : StateSchema.parse(json);
            } catch (error) {
                this.#deps.log.warn(`extension state unreadable, starting empty: ${errorText(error)}`);
                this.#state = EMPTY_STATE;
            }
        }
        return this.#state;
    }

    /** Applies a change to the state file; writes are serialised and atomic. */
    async #updateState(change: (state: State) => State): Promise<void> {
        const run = this.#writing.then(async () => {
            const next = change(await this.#readState());
            await mkdir(this.#deps.dir, { recursive: true });
            const temp = `${this.#stateFile}.${process.pid}.tmp`;
            await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
            await rename(temp, this.#stateFile);
            this.#state = next;
        });
        this.#writing = run.catch(() => undefined);
        await run;
    }

    #changed(): void {
        this.#deps.bus.broadcast('extension.changed', {});
    }

    /** Writes the built-in skills once per start, so an update of the app updates them too. */
    #ensureBuiltins(): Promise<void> {
        this.#builtins ??= (async () => {
            for (const [name, text] of Object.entries(builtinSkills(this.#deps.dir))) {
                const file = path.join(this.#deps.dir, 'builtin', 'skills', name, 'SKILL.md');
                const current = await readFile(file, 'utf8').catch(() => undefined);
                if (current !== text) {
                    await mkdir(path.dirname(file), { recursive: true });
                    await writeFile(file, text);
                }
            }
        })().catch((error: unknown) => {
            this.#builtins = undefined;
            this.#deps.log.warn(`built-in skills: ${errorText(error)}`);
        });
        return this.#builtins;
    }

    async #project(projectId: string | undefined): Promise<Project | undefined> {
        return projectId ? this.#deps.projects.get(projectId) : undefined;
    }

    /** Reads every extension visible from a project (or only the user's and plugins' without one). */
    async load(project?: Project): Promise<LoadedExtensions> {
        const state = await this.#readState();
        const trusted = project?.trusted ?? false;
        const dir = this.#deps.dir;
        const diagnostics: string[] = [];
        const projectSource = (rel: string) => ({
            dir: path.join(project?.path ?? '', rel),
            origin: 'project' as const,
            trusted,
        });
        const userSource = (folder: string) => ({ dir: folder, origin: 'user' as const, trusted: true });

        const plugins: Array<{ installed: InstalledPlugin; info?: PluginInfo }> = [];
        for (const installed of await this.plugins.list().catch(() => [])) {
            try {
                const info = await this.plugins.read(installed.name);
                plugins.push({ installed, info });
                diagnostics.push(...info.diagnostics.filter((d) => d.severity !== 'info').map(message));
            } catch (error) {
                plugins.push({ installed });
                diagnostics.push(`插件${installed.name}读不出来：${errorText(error)}`);
            }
        }
        const enabledPlugins = plugins.flatMap((plugin) =>
            plugin.installed.enabled && plugin.info ? [plugin.info] : [],
        );

        await this.#ensureBuiltins();
        const skillFound = await discoverSkills([
            ...(project ? ['.xora/skills', '.agents/skills', '.claude/skills'].map(projectSource) : []),
            userSource(path.join(dir, 'skills')),
            userSource(path.join(this.#home, '.agents', 'skills')),
            { dir: path.join(dir, 'builtin', 'skills'), origin: 'builtin' as const, trusted: true },
        ]);
        const skills = [...skillFound.skills];
        const skillIds = new Set(skills.map((skill) => skill.id));
        for (const skill of enabledPlugins.flatMap((plugin) => plugin.components.skills)) {
            if (!skillIds.has(skill.id)) {
                skills.push(skill);
                skillIds.add(skill.id);
            }
        }

        const commandFound = await discoverCommands([
            ...(project ? ['.xora/commands', '.claude/commands'].map(projectSource) : []),
            userSource(path.join(dir, 'commands')),
        ]);
        const commands = [...commandFound.commands];
        const commandNames = new Set(commands.map((command) => command.name));
        for (const command of enabledPlugins.flatMap((plugin) => plugin.components.commands)) {
            if (!commandNames.has(command.name)) {
                commands.push(command);
                commandNames.add(command.name);
            }
        }

        const agentFound = await discoverAgents([
            ...(project ? ['.xora/agents', '.claude/agents'].map(projectSource) : []),
            userSource(path.join(dir, 'agents')),
        ]);
        const agents = [...agentFound.agents];
        const agentNames = new Set(agents.map((agent) => agent.name));
        for (const agent of enabledPlugins.flatMap((plugin) => plugin.components.agents)) {
            if (!agentNames.has(agent.name)) {
                agents.push(agent);
                agentNames.add(agent.name);
            }
        }

        const hookFound = await loadHookConfigs([
            { path: path.join(dir, 'hooks.json'), origin: 'user', trusted: true },
            ...(project
                ? [
                      { path: path.join(project.path, '.xora', 'hooks.json'), origin: 'project' as const, trusted },
                      {
                          path: path.join(project.path, '.claude', 'settings.json'),
                          origin: 'project' as const,
                          trusted,
                      },
                  ]
                : []),
        ]);
        const hooks = [...hookFound.configs, ...enabledPlugins.flatMap((plugin) => plugin.components.hooks)];

        for (const found of [skillFound, commandFound, agentFound, hookFound]) {
            diagnostics.push(...found.diagnostics.filter((d) => d.severity !== 'info').map(message));
        }

        const mcp: McpEntry[] = [];
        const names = new Set<string>();
        const addEntry = (entry: McpEntry) => {
            if (names.has(entry.config.name)) {
                diagnostics.push(`mcp服务器重名，已忽略：${entry.config.name}（${entry.source}）`);
                return;
            }
            names.add(entry.config.name);
            mcp.push(entry);
        };
        const fromStored = (stored: StoredServer, scope: string, keyPrefix: string) => {
            const checked = parseServerConfig({
                name: stored.name,
                transport: stored.transport,
                enabled: true,
                origin: stored.origin,
                trusted: true,
                ...(stored.transport === 'stdio'
                    ? {
                          command: stored.command,
                          args: stored.args ?? [],
                          env: Object.fromEntries(stored.envKeys.map((key) => [key, ''])),
                      }
                    : {
                          url: stored.url,
                          headers: Object.fromEntries(stored.headerKeys.map((key) => [key, ''])),
                      }),
            });
            if (!checked.ok) {
                diagnostics.push(`mcp服务器${stored.name}配置有误：${checked.reason}`);
                return;
            }
            addEntry({
                key: `${keyPrefix}${stored.name}`,
                config: checked.config,
                secretKey: secretKeyOf(scope, stored.name),
                source: stored.importedFrom ?? 'settings',
                ...(stored.missingSecrets?.length ? { missingSecrets: stored.missingSecrets } : {}),
            });
        };
        if (project) {
            for (const stored of state.projectServers[project.id] ?? []) {
                fromStored(stored, project.id, `project:${project.id}:`);
            }
            for (const file of [path.join(project.path, '.mcp.json'), path.join(project.path, '.xora', 'mcp.json')]) {
                try {
                    const json = await readJson(file);
                    if (json === undefined) continue;
                    const { configs, problems } = repoServers(json, trusted);
                    diagnostics.push(...problems.map((problem) => `${file}：${problem}`));
                    for (const config of configs) {
                        addEntry({ key: `repo:${project.id}:${config.name}`, config, source: file });
                    }
                } catch (error) {
                    diagnostics.push(`${file}：${errorText(error)}`);
                }
            }
        }
        for (const stored of state.servers) {
            fromStored(stored, 'global', 'global:');
        }
        for (const plugin of enabledPlugins) {
            for (const [raw, value] of Object.entries(plugin.components.mcpServers)) {
                const { configs, problems } = repoServers({ mcpServers: { [raw]: value } }, true);
                diagnostics.push(...problems.map((problem) => `插件${plugin.manifest.name}：${problem}`));
                for (const config of configs) {
                    addEntry({
                        key: `plugin:${plugin.manifest.name}:${config.name}`,
                        config: { ...config, origin: 'plugin' },
                        source: plugin.root,
                    });
                }
            }
        }

        return {
            project,
            trusted,
            skills,
            commands,
            agents,
            hooks,
            mcp,
            plugins,
            diagnostics,
            disabledSkills: new Set(state.disabledSkills),
            disabledMcp: new Set(state.disabledMcp),
        };
    }

    async snapshot(projectId?: string): Promise<ExtensionsSnapshot> {
        const loaded = await this.load(await this.#project(projectId));
        const origin = (value: ExtensionOrigin) => value;
        return {
            projectTrusted: loaded.trusted,
            skills: loaded.skills.map((skill) => ({
                name: skill.id,
                description: skill.description,
                origin: origin(skill.origin),
                path: skill.dir,
                trusted: effectiveTrust(skill.origin, skill.trusted).runSkillScripts,
                enabled: !loaded.disabledSkills.has(skill.id),
                ...(skill.pluginName ? { plugin: skill.pluginName } : {}),
            })),
            commands: loaded.commands.map((command) => ({
                name: command.name,
                ...(command.description ? { description: command.description } : {}),
                ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
                origin: origin(command.origin),
                path: command.file,
            })),
            agents: loaded.agents.map((agent) => ({
                name: agent.name,
                description: agent.description,
                origin: origin(agent.origin),
                path: agent.file,
                ...(agent.tier ? { tier: agent.tier } : {}),
                ...(agent.role ? { role: agent.role } : {}),
            })),
            hooks: loaded.hooks.flatMap((config) =>
                config.groups.flatMap((group) =>
                    group.hooks.map((handler) => ({
                        event: group.event,
                        ...(group.matcher ? { matcher: group.matcher } : {}),
                        command:
                            handler.type === 'command'
                                ? [handler.command, ...(handler.args ?? [])].join(' ')
                                : handler.url,
                        origin: origin(config.source.origin),
                        source: config.source.path,
                        trusted: effectiveTrust(config.source.origin, config.source.trusted).runHooks,
                    })),
                ),
            ),
            mcpServers: loaded.mcp.map((entry) => {
                const reported = projectId ? this.#live.get(`${projectId}:${entry.config.name}`) : undefined;
                const test = this.#tested.get(entry.key);
                const live = reported && (!test || reported.at > test.at) ? reported : undefined;
                const tested: { ok: boolean; tools: number; error?: string; needsAuth?: boolean } | undefined = live
                    ? { ok: live.status !== 'failed', tools: live.tools, ...(live.error ? { error: live.error } : {}) }
                    : test;
                return {
                    name: entry.config.name,
                    transport: entry.config.transport,
                    target: targetOf(entry.config),
                    origin: entry.config.origin,
                    enabled: !loaded.disabledMcp.has(entry.key),
                    trusted: entry.config.trusted,
                    status:
                        live && (live.status === 'running' || live.status === 'starting' || live.status === 'stopped')
                            ? live.status
                            : tested
                              ? tested.ok
                                  ? 'unknown'
                                  : 'failed'
                              : 'unknown',
                    ...(tested?.error ? { error: tested.error } : {}),
                    ...(tested?.ok ? { tools: tested.tools } : {}),
                    ...(tested?.needsAuth ? { needsAuth: true } : {}),
                    scope: entry.key.split(':')[0] as 'global' | 'project' | 'repo' | 'plugin',
                    ...(entry.missingSecrets ? { missingSecrets: [...entry.missingSecrets] } : {}),
                };
            }),
            plugins: loaded.plugins.map(({ installed, info }) => ({
                name: installed.name,
                version: installed.version,
                ...(info?.manifest.description ? { description: info.manifest.description } : {}),
                enabled: installed.enabled,
                source: installed.source.kind === 'git' ? installed.source.url : installed.source.path,
                installedAt: Date.parse(installed.installedAt) || 0,
                components: {
                    skills: info?.components.skills.length ?? 0,
                    commands: info?.components.commands.length ?? 0,
                    agents: info?.components.agents.length ?? 0,
                    hooks: info?.components.hooks.reduce((count, config) => count + config.groups.length, 0) ?? 0,
                    mcpServers: Object.keys(info?.components.mcpServers ?? {}).length,
                },
                permissions: permissionLines(installed.permissions),
            })),
            diagnostics: [...loaded.diagnostics],
        };
    }

    async toggle(params: {
        kind: 'skill' | 'mcp' | 'plugin';
        name: string;
        enabled: boolean;
        projectId?: string;
    }): Promise<void> {
        if (params.kind === 'plugin') {
            await this.plugins.enable(params.name, params.enabled);
        } else if (params.kind === 'skill') {
            await this.#updateState((state) => ({
                ...state,
                disabledSkills: params.enabled
                    ? state.disabledSkills.filter((id) => id !== params.name)
                    : [...new Set([...state.disabledSkills, params.name])],
            }));
        } else {
            const loaded = await this.load(await this.#project(params.projectId));
            const entry = loaded.mcp.find((item) => item.config.name === params.name);
            if (!entry) {
                throw new RpcError(RpcErrorCode.NotFound, `没有名为${params.name}的mcp服务器`);
            }
            await this.#updateState((state) => ({
                ...state,
                disabledMcp: params.enabled
                    ? state.disabledMcp.filter((key) => key !== entry.key)
                    : [...new Set([...state.disabledMcp, entry.key])],
            }));
        }
        this.#changed();
    }

    /** Trusting a project lets its hooks and MCP servers run and its skills run scripts (09 §5). */
    async trust(projectId: string, trusted: boolean): Promise<void> {
        await this.#deps.projects.update(projectId, { trusted });
        this.#changed();
    }

    /** Installs a plugin disabled; enabling it is the user's confirmation of the permissions shown (09 §3). */
    async installPlugin(
        source:
            | { kind: 'dir'; path: string }
            | { kind: 'git'; url: string; ref?: string }
            | { kind: 'market'; market: string; plugin: string },
    ) {
        try {
            let result: Awaited<ReturnType<PluginStore['install']>>;
            if (source.kind === 'market') {
                const market = await this.#readMarket(source.market);
                const entry = market.plugins.find((item) => item.name === source.plugin);
                if (!entry) {
                    throw new Error(`市场${source.market}里没有插件${source.plugin}`);
                }
                if (entry.source.kind === 'unsupported') {
                    throw new Error(`暂不支持这种插件来源：${entry.source.type}`);
                }
                result = await this.plugins.install(entry.source, {
                    enable: false,
                    expectedName: entry.name,
                    entry: entry.entry,
                });
            } else {
                result = await this.plugins.install(source, { enable: false });
            }
            this.#changed();
            return {
                name: result.plugin.name,
                version: result.plugin.version,
                permissions: permissionLines(result.permissions),
                permissionsGrew: result.permissionsGrew,
            };
        } catch (error) {
            throw new RpcError(RpcErrorCode.Rejected, `插件安装失败：${errorText(error)}`);
        }
    }

    // Marketplaces ----------------------------------------------------------------------------------------------

    #marketDir(name: string): string {
        return path.join(this.#deps.dir, 'markets', name);
    }

    async #readMarket(name: string): Promise<Marketplace> {
        const state = await this.#readState();
        const market = state.markets.find((item) => item.name === name);
        if (!market) {
            throw new RpcError(RpcErrorCode.NotFound, `没有名为${name}的插件市场`);
        }
        return readMarketplace(market.source.kind === 'dir' ? market.source.path : this.#marketDir(name));
    }

    /** Clones a git marketplace into a temporary folder; the caller moves or removes it. */
    async #fetchMarket(source: MarketSource): Promise<{ dir: string; temporary: boolean }> {
        if (source.kind === 'dir') {
            return { dir: source.path, temporary: false };
        }
        const dir = path.join(this.#deps.dir, 'markets', `.tmp-${randomBytes(6).toString('hex')}`);
        await mkdir(path.dirname(dir), { recursive: true });
        await gitClone({
            url: source.url,
            dest: dir,
            ...(source.ref ? { ref: source.ref } : {}),
            env: defaultGitEnv(),
        });
        return { dir, temporary: true };
    }

    async addMarket(source: MarketSource): Promise<{ name: string; plugins: number }> {
        const fetched = await this.#fetchMarket(source).catch((error: unknown) => {
            throw new RpcError(RpcErrorCode.Rejected, `读取插件市场失败：${errorText(error)}`);
        });
        try {
            const market = await readMarketplace(fetched.dir).catch((error: unknown) => {
                throw new RpcError(
                    RpcErrorCode.Rejected,
                    `不是插件市场（没有${'.claude-plugin/marketplace.json'}）：${errorText(error)}`,
                );
            });
            if (!MARKET_NAME.test(market.name)) {
                throw new RpcError(RpcErrorCode.Rejected, `插件市场的名字不合规：${market.name}`);
            }
            if (fetched.temporary) {
                await rm(this.#marketDir(market.name), { recursive: true, force: true });
                await rename(fetched.dir, this.#marketDir(market.name));
            }
            const stored = source.kind === 'dir' ? { kind: 'dir' as const, path: path.resolve(source.path) } : source;
            await this.#updateState((state) => ({
                ...state,
                markets: [
                    ...state.markets.filter((item) => item.name !== market.name),
                    { name: market.name, source: stored, addedAt: Date.now() },
                ],
            }));
            this.#changed();
            return { name: market.name, plugins: market.plugins.length };
        } finally {
            if (fetched.temporary) {
                await rm(fetched.dir, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }

    /** Fetches a git marketplace again. */
    async refreshMarket(name: string): Promise<void> {
        const market = (await this.#readState()).markets.find((item) => item.name === name);
        if (!market) {
            throw new RpcError(RpcErrorCode.NotFound, `没有名为${name}的插件市场`);
        }
        await this.addMarket(market.source);
    }

    async removeMarket(name: string): Promise<void> {
        await this.#updateState((state) => ({ ...state, markets: state.markets.filter((item) => item.name !== name) }));
        await rm(this.#marketDir(name), { recursive: true, force: true });
        this.#changed();
    }

    async markets() {
        const state = await this.#readState();
        const installed = new Set((await this.plugins.list().catch(() => [])).map((plugin) => plugin.name));
        const out = [];
        for (const item of state.markets) {
            const source = item.source.kind === 'dir' ? item.source.path : item.source.url;
            try {
                const market = await this.#readMarket(item.name);
                out.push({
                    name: item.name,
                    source,
                    ...(market.description ? { description: market.description } : {}),
                    plugins: market.plugins.map((plugin) => ({
                        name: plugin.name,
                        ...(plugin.description ? { description: plugin.description } : {}),
                        ...(plugin.version ? { version: plugin.version } : {}),
                        installable: plugin.source.kind !== 'unsupported',
                        installed: installed.has(plugin.name),
                    })),
                    diagnostics: market.diagnostics.filter((d) => d.severity !== 'info').map(message),
                });
            } catch (error) {
                out.push({ name: item.name, source, plugins: [], diagnostics: [errorText(error)] });
            }
        }
        return out;
    }

    async uninstallPlugin(name: string): Promise<void> {
        if (!(await this.plugins.uninstall(name))) {
            throw new RpcError(RpcErrorCode.NotFound, `没有安装插件${name}`);
        }
        this.#changed();
    }

    // MCP configuration -------------------------------------------------------------------------------------

    async saveMcp(params: {
        name: string;
        scope: 'global' | 'project';
        projectId?: string;
        transport: 'stdio' | 'http';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
    }): Promise<void> {
        const scope = this.#scope(params.scope, params.projectId);
        const checked = parseServerConfig({
            name: params.name,
            transport: params.transport,
            enabled: true,
            origin: params.scope,
            trusted: true,
            ...(params.transport === 'stdio'
                ? { command: params.command, args: params.args ?? [], env: params.env ?? {} }
                : { url: params.url, headers: params.headers ?? {} }),
        });
        if (!checked.ok) {
            throw new RpcError(RpcErrorCode.InvalidParams, checked.reason);
        }
        const env = params.transport === 'stdio' ? (params.env ?? {}) : {};
        const headers = params.transport === 'http' ? (params.headers ?? {}) : {};
        const stored: StoredServer = {
            name: params.name,
            transport: params.transport,
            ...(params.transport === 'stdio'
                ? { command: params.command, args: params.args ?? [] }
                : { url: params.url }),
            envKeys: Object.keys(env),
            headerKeys: Object.keys(headers),
            origin: params.scope,
        };
        const key = secretKeyOf(scope, params.name);
        if (Object.keys(env).length + Object.keys(headers).length > 0) {
            await this.#deps.shell.setSecret(key, JSON.stringify({ env, headers }));
        } else {
            await this.#deps.shell.deleteSecret(key).catch(() => undefined);
        }
        await this.#updateState((state) => this.#withServer(state, scope, params.name, stored));
        this.#tested.delete(scope === 'global' ? `global:${params.name}` : `project:${scope}:${params.name}`);
        this.#changed();
    }

    async removeMcp(params: { name: string; scope: 'global' | 'project'; projectId?: string }): Promise<void> {
        const scope = this.#scope(params.scope, params.projectId);
        await this.#updateState((state) => this.#withServer(state, scope, params.name, undefined));
        await this.#deps.shell.deleteSecret(secretKeyOf(scope, params.name)).catch(() => undefined);
        this.#changed();
    }

    #scope(scope: 'global' | 'project', projectId: string | undefined): string {
        if (scope === 'global') {
            return 'global';
        }
        if (!projectId) {
            throw new RpcError(RpcErrorCode.InvalidParams, '项目级的mcp服务器要指定项目');
        }
        return projectId;
    }

    #withServer(state: State, scope: string, name: string, server: StoredServer | undefined): State {
        const replace = (list: readonly StoredServer[]) => [
            ...list.filter((item) => item.name !== name),
            ...(server ? [server] : []),
        ];
        if (scope === 'global') {
            return { ...state, servers: replace(state.servers) };
        }
        return {
            ...state,
            projectServers: { ...state.projectServers, [scope]: replace(state.projectServers[scope] ?? []) },
        };
    }

    /** MCP servers configured in Claude Code, Cursor, VS Code and Codex; secrets are never copied (09 §6). */
    async discoverMcp(projectId?: string) {
        const project = await this.#project(projectId);
        const result = await importServers({
            home: this.#home,
            ...(project ? { projectDir: project.path } : {}),
        });
        return result.servers.map((server) => ({
            name: server.config.name,
            tool: server.source.tool,
            file: server.source.file,
            transport: server.config.transport,
            target: targetOf(server.config),
            secretKeys: [...server.secretKeys],
        }));
    }

    async importMcp(names: readonly string[], projectId?: string): Promise<{ imported: string[] }> {
        const project = await this.#project(projectId);
        const result = await importServers({ home: this.#home, ...(project ? { projectDir: project.path } : {}) });
        const imported: string[] = [];
        for (const name of names) {
            const server = result.servers.find((item) => item.config.name === name);
            if (!server) continue;
            const config = server.config;
            const scope = project && server.source.scope !== 'user' ? project.id : 'global';
            const env = config.transport === 'stdio' ? config.env : {};
            const headers = config.transport === 'stdio' ? {} : config.headers;
            const stored: StoredServer = {
                name: config.name,
                transport: config.transport,
                ...(config.transport === 'stdio'
                    ? { command: config.command, args: [...config.args] }
                    : { url: config.url }),
                envKeys: Object.keys(env),
                headerKeys: Object.keys(headers),
                origin: scope === 'global' ? 'imported' : 'project',
                importedFrom: server.source.file,
                ...(server.secretKeys.length > 0 ? { missingSecrets: [...server.secretKeys] } : {}),
            };
            const filled = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
            const filledHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== ''));
            if (Object.keys(filled).length + Object.keys(filledHeaders).length > 0) {
                await this.#deps.shell.setSecret(
                    secretKeyOf(scope, config.name),
                    JSON.stringify({ env: filled, headers: filledHeaders }),
                );
            }
            await this.#updateState((state) => this.#withServer(state, scope, config.name, stored));
            imported.push(config.name);
        }
        if (imported.length > 0) this.#changed();
        return { imported };
    }

    async #entry(name: string, projectId?: string): Promise<McpEntry> {
        const loaded = await this.load(await this.#project(projectId));
        const entry = loaded.mcp.find((item) => item.config.name === name);
        if (!entry) {
            throw new RpcError(RpcErrorCode.NotFound, `没有名为${name}的mcp服务器`);
        }
        return entry;
    }

    /** The config with its secrets and OAuth token filled in, ready to start. */
    async #resolve(entry: McpEntry): Promise<McpServerConfig> {
        let config = entry.config;
        if (entry.secretKey) {
            const raw = await this.#deps.shell.getSecret(entry.secretKey).catch(() => null);
            const secrets = raw
                ? (JSON.parse(raw) as { env?: Record<string, string>; headers?: Record<string, string> })
                : {};
            config =
                config.transport === 'stdio'
                    ? { ...config, env: { ...config.env, ...secrets.env } }
                    : { ...config, headers: { ...config.headers, ...secrets.headers } };
        }
        if (config.transport !== 'stdio') {
            const headers = Object.fromEntries(Object.entries(config.headers).filter(([, value]) => value !== ''));
            const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
            const auth = hasAuth ? {} : await authHeaders(config.url, this.#storage).catch(() => ({}));
            config = { ...config, headers: { ...headers, ...auth } };
        } else {
            config = {
                ...config,
                env: Object.fromEntries(Object.entries(config.env).filter(([, value]) => value !== '')),
            };
        }
        return config;
    }

    /** Starts the server once, lists its tools and stops it (user-initiated, so untrusted servers may be tested). */
    async testMcp(name: string, projectId?: string): Promise<{ ok: boolean; tools: string[]; error?: string }> {
        const entry = await this.#entry(name, projectId);
        const connection = new McpConnection();
        try {
            await connection.connect(await this.#resolve(entry), {
                baseEnv: safeBaseEnv(),
                clientInfo: { name: 'xora-code', version: '1.0.0' },
                connectTimeoutMs: 30_000,
            });
            const tools = (await connection.listTools()).map((tool) => tool.name);
            this.#tested.set(entry.key, { ok: true, tools: tools.length, at: Date.now() });
            return { ok: true, tools };
        } catch (error) {
            const text = errorText(error);
            const needsAuth = /401|unauthori[sz]ed/i.test(text) && entry.config.transport !== 'stdio';
            this.#tested.set(entry.key, {
                ok: false,
                tools: 0,
                error: text,
                ...(needsAuth ? { needsAuth } : {}),
                at: Date.now(),
            });
            return { ok: false, tools: [], error: text };
        } finally {
            await connection.close().catch(() => undefined);
            this.#changed();
        }
    }

    /** OAuth 2.1 with PKCE in the browser; the tokens go to the secret store (09 §2). */
    async authorizeMcp(name: string, projectId?: string): Promise<void> {
        const entry = await this.#entry(name, projectId);
        if (entry.config.transport === 'stdio') {
            throw new RpcError(RpcErrorCode.InvalidParams, '本地（stdio）mcp服务器不需要授权');
        }
        try {
            await authorize(entry.config.url, {
                storage: this.#storage,
                openBrowser: (url) => this.#deps.shell.open('external', url),
                clientName: 'Xora Code',
            });
        } catch (error) {
            throw new RpcError(RpcErrorCode.Rejected, `授权失败：${errorText(error)}`);
        }
        this.#tested.delete(entry.key);
        this.#changed();
    }

    // Sessions ----------------------------------------------------------------------------------------------

    #enabledSkills(loaded: LoadedExtensions): Skill[] {
        return loaded.skills.filter(
            (skill) => !loaded.disabledSkills.has(skill.id) && effectiveTrust(skill.origin, skill.trusted).readSkills,
        );
    }

    /** The prompt layers extensions add, for "view the effective prompt"; reads no secrets. */
    async promptLayers(project: Project): Promise<Array<{ id: string; title: string; text: string }>> {
        const skills = this.#enabledSkills(await this.load(project));
        return skills.length > 0 ? [{ id: 'skills', title: 'Skills', text: skillIndex(skills) }] : [];
    }

    async forSession(project: Project): Promise<SessionExtras> {
        const loaded = await this.load(project);
        const skills = this.#enabledSkills(loaded);
        const runnable = loaded.mcp.filter(
            (entry) =>
                !loaded.disabledMcp.has(entry.key) &&
                effectiveTrust(
                    entry.config.origin === 'plugin'
                        ? 'plugin'
                        : entry.config.origin === 'project'
                          ? 'project'
                          : 'user',
                    entry.config.trusted,
                ).startMcpServers,
        );
        const configs: McpServerConfig[] = [];
        for (const entry of runnable) {
            try {
                configs.push(await this.#resolve(entry));
            } catch (error) {
                this.#deps.log.warn(`mcp ${entry.config.name}: ${errorText(error)}`);
            }
        }
        const hooks = this.#runnableHooks(loaded);
        return {
            loaded,
            skills,
            layers: skills.length > 0 ? [{ id: 'skills', title: 'Skills', text: skillIndex(skills) }] : [],
            tools:
                skills.length > 0
                    ? [
                          {
                              name: SKILL_TOOL,
                              description:
                                  'Loads a skill from the skills index: its instructions, and the list of its files. Pass `file` to read one of those files.',
                              parameters: {
                                  type: 'object',
                                  properties: {
                                      name: { type: 'string', description: 'The skill id from the index.' },
                                      file: { type: 'string', description: 'A file inside the skill, relative to it.' },
                                  },
                                  required: ['name'],
                                  additionalProperties: false,
                              },
                              kind: 'read',
                          },
                      ]
                    : [],
            mcpConfigs: configs,
            hookEvents: (['PreToolUse', 'PostToolUse'] as const).filter((event) =>
                hooks.some((config) => config.groups.some((group) => group.event === event)),
            ),
        };
    }

    /** Server statuses the xora engine reported when a session opened. */
    reportMcp(
        projectId: string,
        statuses: ReadonlyArray<{ name: string; status: string; tools: number; error?: string }>,
    ): void {
        let changed = false;
        for (const status of statuses) {
            const key = `${projectId}:${status.name}`;
            const before = this.#live.get(key);
            if (before?.status !== status.status || before.tools !== status.tools || before.error !== status.error) {
                changed = true;
            }
            this.#live.set(key, {
                status: status.status,
                tools: status.tools,
                ...(status.error ? { error: status.error } : {}),
                at: Date.now(),
            });
        }
        if (changed) this.#changed();
    }

    /** The servers for `session/new`, limited to the transports the agent supports. */
    mcpServersFor(extras: SessionExtras | undefined, capabilities: AcpMcpCapabilities): AcpMcpServer[] {
        if (!extras || extras.mcpConfigs.length === 0) {
            return [];
        }
        const converted = toAcpMcpServers(extras.mcpConfigs, capabilities);
        for (const skipped of converted.skipped) {
            this.#deps.log.info(`mcp ${skipped.name} not passed to the agent: ${skipped.reason}`);
        }
        return converted.servers;
    }

    #runnableHooks(loaded: LoadedExtensions): HookConfig[] {
        return loaded.hooks.filter((config) => effectiveTrust(config.source.origin, config.source.trusted).runHooks);
    }

    /** The `skill` tool: a skill's instructions, or one of its files. */
    async handleTool(extras: SessionExtras, name: string, input: unknown): Promise<HostToolResult> {
        if (name !== SKILL_TOOL) {
            return { content: `Tool ${name} is not available in this thread.`, isError: true };
        }
        const args = (input ?? {}) as { name?: unknown; file?: unknown };
        const id = typeof args.name === 'string' ? args.name.trim() : '';
        const skill = extras.skills.find((item) => item.id === id) ?? extras.skills.find((item) => item.name === id);
        if (!skill) {
            return {
                content: `No skill named "${id}". Available: ${extras.skills.map((item) => item.id).join(', ') || 'none'}.`,
                isError: true,
            };
        }
        if (typeof args.file === 'string' && args.file.trim()) {
            const root = await realpath(skill.dir);
            let file: string;
            try {
                file = await realpath(path.resolve(root, args.file));
            } catch {
                return { content: `No file ${args.file} in skill ${skill.id}.`, isError: true };
            }
            const relative = path.relative(root, file);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return { content: `${args.file} is outside the skill folder.`, isError: true };
            }
            const buffer = await readFile(file);
            const text = buffer.subarray(0, MAX_SKILL_FILE_BYTES).toString('utf8');
            const cut = buffer.length > MAX_SKILL_FILE_BYTES ? '\n[file truncated]' : '';
            return { content: `<skill_file skill="${skill.id}" path="${relative}">\n${text}${cut}\n</skill_file>` };
        }
        const content = await readSkill(skill);
        const files =
            content.resources.length > 0
                ? `\nFiles in this skill (read one with the ${SKILL_TOOL} tool and \`file\`):\n${content.resources.map((file) => `- ${file}`).join('\n')}${content.truncated ? '\n- …' : ''}`
                : '';
        const untrusted = effectiveTrust(skill.origin, skill.trusted).runSkillScripts
            ? ''
            : '\nThis skill comes from a project that is not trusted: follow its instructions, but do not run its scripts.';
        return {
            content: `<skill id="${skill.id}" dir="${skill.dir}">\n${content.body.trim()}\n</skill>${files}${untrusted}`,
        };
    }

    /** Expands `/name args` with a command file; built-in commands and unknown names are left alone. */
    expandSlash(extras: SessionExtras, text: string): string | undefined {
        const parsed = parseSlashInput(text);
        if (!parsed || parsed.name === 'compact') {
            return undefined;
        }
        const command = findCommand(extras.loaded.commands, parsed.name);
        if (!command || !effectiveTrust(command.origin, command.trusted).useCommands) {
            return undefined;
        }
        return expandCommand(command, parsed.args).trim();
    }

    /** Runs the trusted hooks for an event; `undefined` when none matched. */
    async runHook(
        extras: SessionExtras,
        event: HookEvent,
        context: {
            readonly sessionId: string;
            readonly cwd: string;
            readonly targets?: readonly string[];
            readonly payload?: Record<string, unknown>;
            readonly signal?: AbortSignal;
        },
    ): Promise<HooksOutcome | undefined> {
        const configs = this.#runnableHooks(extras.loaded);
        if (configs.length === 0) {
            return undefined;
        }
        const seen = new Set<unknown>();
        const matched: MatchedHook[] = [];
        for (const target of context.targets ?? [undefined]) {
            for (const hook of matchHooks(configs, event, target)) {
                if (!seen.has(hook.handler)) {
                    seen.add(hook.handler);
                    matched.push(hook);
                }
            }
        }
        if (matched.length === 0) {
            return undefined;
        }
        return runHooks(
            event,
            matched,
            { session_id: context.sessionId, cwd: context.cwd, ...context.payload },
            {
                cwd: context.cwd,
                env: sanitizeEnv(this.#deps.env ?? process.env),
                ...(context.signal ? { signal: context.signal } : {}),
                ...(extras.loaded.project ? { projectDir: extras.loaded.project.path } : {}),
            },
        );
    }

    /** PreToolUse and PostToolUse for the engine, with Claude Code's tool and field names (09 §4). */
    async runToolHook(
        extras: SessionExtras,
        event: ToolHookEvent,
        payload: { tool_name: string; tool_input: unknown; tool_use_id: string; tool_response?: unknown },
        context: { readonly sessionId: string; readonly cwd: string; readonly signal?: AbortSignal },
    ): Promise<ToolHookReply> {
        const native = payload.tool_name;
        const claude = CLAUDE_TOOL_NAMES[native] ?? native;
        const input =
            payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
                ? { ...(payload.tool_input as Record<string, unknown>) }
                : {};
        for (const [ours, theirs] of INPUT_ALIASES) {
            if (ours in input && !(theirs in input)) input[theirs] = input[ours];
        }
        const outcome = await this.runHook(extras, event, {
            ...context,
            targets: claude === native ? [native] : [claude, native],
            payload: {
                tool_name: claude,
                tool_input: input,
                tool_use_id: payload.tool_use_id,
                xora_tool_name: native,
                ...(payload.tool_response === undefined ? {} : { tool_response: payload.tool_response }),
            },
        });
        if (!outcome) {
            return {};
        }
        let updatedInput: Record<string, unknown> | undefined;
        if (outcome.updatedInput) {
            updatedInput = { ...outcome.updatedInput };
            for (const [ours, theirs] of INPUT_ALIASES) {
                if (theirs in updatedInput) {
                    if (!(ours in updatedInput) || updatedInput[ours] === input[ours]) {
                        updatedInput[ours] = updatedInput[theirs];
                    }
                    delete updatedInput[theirs];
                }
            }
        }
        const reason = [outcome.reason, ...outcome.messages].filter(Boolean).join('\n') || undefined;
        return {
            ...(outcome.blocked ? { blocked: true } : {}),
            ...(reason ? { reason } : {}),
            ...(outcome.decision ? { decision: outcome.decision } : {}),
            ...(outcome.additionalContext ? { additionalContext: outcome.additionalContext } : {}),
            ...(updatedInput ? { updatedInput } : {}),
        };
    }
}
