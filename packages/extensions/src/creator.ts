import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidAgentName } from './agents.ts';
import { isValidCommandName } from './commands.ts';
import { type FrontmatterValue, stringifyFrontmatter } from './frontmatter.ts';
import { errorCode, errorMessage, isSameOrInside } from './fs-utils.ts';
import { type HookEventMap, HookEventMapSchema } from './hooks.ts';
import { isValidPluginName, type McpServerConfig, PLUGIN_MANIFEST } from './plugins.ts';
import { isValidSkillName, MAX_SKILL_DESCRIPTION, SKILL_FILE } from './skills.ts';

/**
 * Templates for creating extensions in conversation (09 §3): structured input becomes a plan of files that the UI
 * can preview, and {@link writePlan} writes it without ever overwriting an existing file.
 */

export interface CreationFile {
    /** POSIX path relative to the directory the plan is written into. */
    readonly path: string;
    readonly content: string;
}

export interface CreationPlan {
    readonly kind: 'skill' | 'command' | 'agent' | 'plugin';
    readonly name: string;
    readonly files: readonly CreationFile[];
}

export class CreatorError extends Error {
    readonly code: 'invalid' | 'exists';

    constructor(code: 'invalid' | 'exists', message: string) {
        super(message);
        this.name = 'CreatorError';
        this.code = code;
    }
}

export interface SkillDraft {
    readonly name: string;
    readonly description: string;
    readonly body?: string;
    readonly license?: string;
    readonly compatibility?: string;
    readonly allowedTools?: readonly string[];
    readonly metadata?: Readonly<Record<string, string>>;
    /** Extra files keyed by relative path, e.g. `scripts/run.sh` or `references/api.md`. */
    readonly resources?: Readonly<Record<string, string>>;
}

export interface CommandDraft {
    /** May be namespaced: `frontend:build` is written to `frontend/build.md`. */
    readonly name: string;
    readonly description?: string;
    readonly argumentHint?: string;
    readonly model?: string;
    readonly allowedTools?: readonly string[];
    readonly body: string;
}

export interface AgentDraft {
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    readonly tools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly model?: string;
    readonly tier?: string;
    readonly role?: string;
    readonly mode?: string;
    readonly canDelegate?: boolean;
}

export interface PluginDraft {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly author?: { readonly name: string; readonly email?: string; readonly url?: string };
    readonly homepage?: string;
    readonly repository?: string;
    readonly license?: string;
    readonly keywords?: readonly string[];
    readonly skills?: readonly SkillDraft[];
    readonly commands?: readonly CommandDraft[];
    readonly agents?: readonly AgentDraft[];
    /** Event map, written to `hooks/hooks.json`. */
    readonly hooks?: HookEventMap;
    readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
    /** Xora-specific manifest fields. */
    readonly xora?: Readonly<Record<string, unknown>>;
}

function invalid(message: string): never {
    throw new CreatorError('invalid', message);
}

function required(value: string | undefined, label: string): string {
    const text = value?.trim();
    if (!text) {
        invalid(`${label} is required`);
    }
    return text;
}

/** A relative POSIX path that stays inside the directory it is written to. */
function checkRelative(file: string): string {
    const normalized = file.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (
        normalized === '' ||
        normalized.startsWith('/') ||
        /^[A-Za-z]:/.test(normalized) ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
        invalid(`invalid file path: ${file}`);
    }
    return normalized;
}

function toolList(tools: readonly string[] | undefined): FrontmatterValue | undefined {
    return tools === undefined ? undefined : [...tools];
}

function withNewline(text: string): string {
    return text.endsWith('\n') ? text : `${text}\n`;
}

/** `<name>/SKILL.md` plus resources. */
export function planSkill(draft: SkillDraft): CreationPlan {
    const name = required(draft.name, 'skill name');
    if (!isValidSkillName(name)) {
        invalid(`invalid skill name "${name}": use lowercase letters, digits and single hyphens, at most 64`);
    }
    const description = required(draft.description, 'skill description');
    if (description.length > MAX_SKILL_DESCRIPTION) {
        invalid(`skill description is longer than ${MAX_SKILL_DESCRIPTION} characters`);
    }
    const body = draft.body?.trim() || `# ${name}\n\n${description}`;
    const files: CreationFile[] = [
        {
            path: `${name}/${SKILL_FILE}`,
            content: stringifyFrontmatter(
                {
                    name,
                    description,
                    license: draft.license,
                    compatibility: draft.compatibility,
                    // The Agent Skills format writes allowed tools as one space-separated string.
                    'allowed-tools': draft.allowedTools?.join(' '),
                    metadata: draft.metadata ? { ...draft.metadata } : undefined,
                },
                body,
            ),
        },
    ];
    for (const [file, content] of Object.entries(draft.resources ?? {})) {
        const relative = checkRelative(file);
        if (relative === SKILL_FILE) {
            invalid(`${SKILL_FILE} is generated from the draft`);
        }
        files.push({ path: `${name}/${relative}`, content });
    }
    return { kind: 'skill', name, files };
}

/** `<namespace>/<name>.md`. */
export function planCommand(draft: CommandDraft): CreationPlan {
    const name = required(draft.name, 'command name').replace(/^\//, '');
    if (!isValidCommandName(name)) {
        invalid(`invalid command name "${name}"`);
    }
    const body = required(draft.body, 'command body');
    const data = {
        description: draft.description,
        'argument-hint': draft.argumentHint,
        model: draft.model,
        'allowed-tools': toolList(draft.allowedTools),
    };
    const hasFrontmatter = Object.values(data).some((value) => value !== undefined);
    const content = hasFrontmatter ? stringifyFrontmatter(data, body) : withNewline(body);
    return { kind: 'command', name, files: [{ path: `${name.split(':').join('/')}.md`, content }] };
}

/** `<name>.md` with the agent's frontmatter and its prompt as the body. */
export function planAgent(draft: AgentDraft): CreationPlan {
    const name = required(draft.name, 'agent name');
    if (!isValidAgentName(name) || /[\\/]/.test(name)) {
        invalid(`invalid agent name "${name}"`);
    }
    const description = required(draft.description, 'agent description');
    const prompt = required(draft.prompt, 'agent prompt');
    const content = stringifyFrontmatter(
        {
            name,
            description,
            tools: toolList(draft.tools),
            disallowedTools: toolList(draft.disallowedTools),
            model: draft.model,
            tier: draft.tier,
            role: draft.role,
            mode: draft.mode,
            canDelegate: draft.canDelegate,
        },
        prompt,
    );
    return { kind: 'agent', name, files: [{ path: `${name}.md`, content }] };
}

/** A plugin directory `<name>/` with its manifest and the given skills, commands, agents, hooks and MCP servers. */
export function planPlugin(draft: PluginDraft): CreationPlan {
    const name = required(draft.name, 'plugin name');
    if (!isValidPluginName(name)) {
        invalid(`invalid plugin name "${name}": use letters, digits, ".", "_" and "-"`);
    }
    if (draft.version !== undefined && !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(draft.version)) {
        invalid(`invalid version "${draft.version}"`);
    }
    const manifest = {
        name,
        version: draft.version ?? '0.1.0',
        ...(draft.description === undefined ? {} : { description: draft.description }),
        ...(draft.author === undefined ? {} : { author: draft.author }),
        ...(draft.homepage === undefined ? {} : { homepage: draft.homepage }),
        ...(draft.repository === undefined ? {} : { repository: draft.repository }),
        ...(draft.license === undefined ? {} : { license: draft.license }),
        ...(draft.keywords === undefined ? {} : { keywords: draft.keywords }),
        ...(draft.xora === undefined ? {} : { xora: draft.xora }),
    };
    const files: CreationFile[] = [
        { path: `${name}/${PLUGIN_MANIFEST}`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ];
    const nest = (plan: CreationPlan, dir: string): void => {
        for (const file of plan.files) {
            files.push({ path: `${name}/${dir}/${file.path}`, content: file.content });
        }
    };
    for (const skill of draft.skills ?? []) {
        nest(planSkill(skill), 'skills');
    }
    for (const command of draft.commands ?? []) {
        nest(planCommand(command), 'commands');
    }
    for (const agent of draft.agents ?? []) {
        nest(planAgent(agent), 'agents');
    }
    if (draft.hooks !== undefined) {
        const parsed = HookEventMapSchema.safeParse(draft.hooks);
        if (!parsed.success) {
            invalid(`invalid hooks: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
        }
        files.push({
            path: `${name}/hooks/hooks.json`,
            content: `${JSON.stringify({ hooks: parsed.data }, null, 2)}\n`,
        });
    }
    if (draft.mcpServers !== undefined) {
        for (const [server, config] of Object.entries(draft.mcpServers)) {
            if (typeof config.command !== 'string' && typeof config.url !== 'string') {
                invalid(`MCP server "${server}" needs a command or a url`);
            }
        }
        files.push({
            path: `${name}/.mcp.json`,
            content: `${JSON.stringify({ mcpServers: draft.mcpServers }, null, 2)}\n`,
        });
    }
    const seen = new Set<string>();
    for (const file of files) {
        const key = file.path.toLowerCase();
        if (seen.has(key)) {
            invalid(`two files would be written to ${file.path}`);
        }
        seen.add(key);
    }
    return { kind: 'plugin', name, files };
}

/**
 * Writes a plan below `baseDir`. Refuses, before writing anything, when any of its files exists; files are
 * created exclusively, and the ones already written are removed again if a later one fails.
 */
export async function writePlan(baseDir: string, plan: CreationPlan): Promise<string[]> {
    const base = path.resolve(baseDir);
    const targets = plan.files.map((file) => {
        const target = path.resolve(base, ...checkRelative(file.path).split('/'));
        if (!isSameOrInside(base, target) || target === base) {
            invalid(`file escapes the target directory: ${file.path}`);
        }
        return { target, content: file.content };
    });
    for (const { target } of targets) {
        try {
            await lstat(target);
            throw new CreatorError('exists', `already exists: ${target}`);
        } catch (error) {
            if (error instanceof CreatorError) {
                throw error;
            }
            if (errorCode(error) !== 'ENOENT') {
                throw error;
            }
        }
    }
    const written: string[] = [];
    try {
        for (const { target, content } of targets) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
            written.push(target);
        }
    } catch (error) {
        await Promise.all(written.map((file) => unlink(file).catch(() => undefined)));
        if (errorCode(error) === 'EEXIST') {
            throw new CreatorError('exists', errorMessage(error));
        }
        throw error;
    }
    return written;
}
