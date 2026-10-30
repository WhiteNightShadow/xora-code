import path from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import { errorMessage, listDir, readText } from './fs-utils.ts';
import type { Diagnostic, ExtensionOrigin, ExtensionSource } from './types.ts';
import { field, parseToolList, scalarString, substitute } from './values.ts';

/**
 * Scenario agent definitions (06 §2, §14): markdown with frontmatter whose body is the agent's prompt. Compatible
 * with Claude Code subagent files (`name`, `description`, `tools`, `model`) plus the Xora fields `tier`, `role`,
 * `mode` and `canDelegate`. Found in `.xora/agents/`, `.claude/agents/` and `<data>/agents/`.
 */

export type AgentSource = ExtensionSource;

/** Model tiers (06 §3). */
export const AGENT_TIERS = ['flagship', 'standard', 'economy', 'fast'] as const;
/** Team roles (06 §2). */
export const AGENT_ROLES = [
    'supervisor',
    'planner',
    'plan-reviewer',
    'scout',
    'executor',
    'reviewer',
    'expert',
] as const;
/** Default permission modes (10 §2): ask, auto edit, plan, full access. */
export const AGENT_MODES = ['ask', 'auto-edit', 'plan', 'full'] as const;

export interface AgentDefinition {
    /** Plugin agents are `<plugin>:<name>`, with subdirectories of `agents/` in between. */
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    /** Allowed tools; absent means the default set for the role. */
    readonly tools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly model?: string;
    /** Usually one of {@link AGENT_TIERS}; unknown values are kept and reported. */
    readonly tier?: string;
    /** Usually one of {@link AGENT_ROLES}. */
    readonly role?: string;
    /** Usually one of {@link AGENT_MODES}. From an untrusted project it must not raise the session's mode. */
    readonly mode?: string;
    readonly canDelegate?: boolean;
    readonly file: string;
    readonly origin: ExtensionOrigin;
    readonly trusted: boolean;
    readonly pluginName?: string;
}

export interface AgentDiscovery {
    readonly agents: readonly AgentDefinition[];
    readonly diagnostics: readonly Diagnostic[];
}

/** At most 256 characters, no `:` (it separates plugin namespaces), path separators or control characters. */
export function isValidAgentName(name: string): boolean {
    return (
        name.length > 0 &&
        name.length <= 256 &&
        !name.startsWith('-') &&
        name.trim() === name &&
        !/[:/\\]/.test(name) &&
        ![...name].some((char) => (char.codePointAt(0) ?? 0) < 0x20)
    );
}

function checkKnown(
    value: string | undefined,
    known: readonly string[],
    label: string,
    file: string,
    diagnostics: Diagnostic[],
): void {
    if (value !== undefined && !known.includes(value)) {
        diagnostics.push({ severity: 'warning', message: `unknown ${label} "${value}"`, file });
    }
}

/**
 * Reads one agent file. `namespace` holds the subdirectories below the agents directory; they only become part of
 * the name for plugin agents, as in Claude Code. A file without a `name` is documentation, except in plugins and
 * built-in sources, where the file name is used.
 */
export async function loadAgentFile(
    file: string,
    source: AgentSource,
    namespace: readonly string[] = [],
): Promise<{ agent?: AgentDefinition; diagnostics: Diagnostic[] }> {
    const diagnostics: Diagnostic[] = [];
    let text: string;
    try {
        text = await readText(file);
    } catch (error) {
        return { diagnostics: [{ severity: 'error', message: `cannot read agent: ${errorMessage(error)}`, file }] };
    }
    const parsed = parseFrontmatter(text);
    for (const error of parsed.errors) {
        diagnostics.push({ severity: 'warning', message: `line ${error.line}: ${error.message}`, file });
    }
    const { data } = parsed;
    let name = scalarString(field(data, 'name'))?.trim();
    if (!name) {
        if (source.origin !== 'plugin' && source.origin !== 'builtin') {
            diagnostics.push({ severity: 'info', message: 'no name in frontmatter; treated as documentation', file });
            return { diagnostics };
        }
        name = path.basename(file).replace(/\.md$/i, '');
    }
    if (!isValidAgentName(name)) {
        diagnostics.push({ severity: 'error', message: `invalid agent name "${name}"`, file });
        return { diagnostics };
    }
    const description = scalarString(field(data, 'description'))?.trim();
    if (!description) {
        diagnostics.push({ severity: 'error', message: `agent "${name}" has no description`, file });
        return { diagnostics };
    }
    const tools = parseToolList(field(data, 'tools'));
    const disallowedTools = parseToolList(field(data, 'disallowedTools', 'disallowed-tools'));
    const model = scalarString(field(data, 'model'));
    const tier = scalarString(field(data, 'tier'));
    const role = scalarString(field(data, 'role'));
    const mode = scalarString(field(data, 'mode'));
    checkKnown(tier, AGENT_TIERS, 'tier', file, diagnostics);
    checkKnown(role, AGENT_ROLES, 'role', file, diagnostics);
    checkKnown(mode, AGENT_MODES, 'mode', file, diagnostics);
    const delegate = field(data, 'canDelegate');
    if (delegate !== undefined && typeof delegate !== 'boolean') {
        diagnostics.push({ severity: 'warning', message: 'canDelegate must be true or false; ignored', file });
    }
    const prompt =
        source.pluginRoot === undefined
            ? parsed.body
            : substitute(parsed.body, { CLAUDE_PLUGIN_ROOT: source.pluginRoot });
    const agent: AgentDefinition = {
        name: source.pluginName ? [source.pluginName, ...namespace, name].join(':') : name,
        description,
        prompt: prompt.trim(),
        ...(tools === undefined ? {} : { tools }),
        ...(disallowedTools === undefined ? {} : { disallowedTools }),
        ...(model === undefined ? {} : { model }),
        ...(tier === undefined ? {} : { tier }),
        ...(role === undefined ? {} : { role }),
        ...(mode === undefined ? {} : { mode }),
        ...(typeof delegate === 'boolean' ? { canDelegate: delegate } : {}),
        file,
        origin: source.origin,
        trusted: source.trusted,
        ...(source.pluginName === undefined ? {} : { pluginName: source.pluginName }),
    };
    return { agent, diagnostics };
}

/** Agent files below `dir`, recursively, with their subdirectories. */
export async function agentFiles(dir: string): Promise<{ file: string; namespace: string[] }[]> {
    const found: { file: string; namespace: string[] }[] = [];
    const walk = async (current: string, namespace: string[], depth: number): Promise<void> => {
        for (const entry of await listDir(current)) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && depth < 8) {
                await walk(full, [...namespace, entry.name], depth + 1);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && /\.md$/i.test(entry.name)) {
                found.push({ file: full, namespace });
            }
        }
    };
    await walk(dir, [], 0);
    return found;
}

const ORIGIN_RANK: Readonly<Record<ExtensionOrigin, number>> = { project: 0, user: 1, plugin: 2, builtin: 3 };

/**
 * Agents from every source. When names collide, project definitions override user ones, which override plugin
 * and built-in ones; within one origin the earlier source wins. Overridden files are reported.
 */
export async function discoverAgents(sources: readonly AgentSource[]): Promise<AgentDiscovery> {
    const diagnostics: Diagnostic[] = [];
    const ordered = sources
        .map((source, index) => ({ source, index }))
        .sort((a, b) => ORIGIN_RANK[a.source.origin] - ORIGIN_RANK[b.source.origin] || a.index - b.index);
    const byName = new Map<string, AgentDefinition>();
    for (const { source } of ordered) {
        const files = await agentFiles(source.dir);
        const loaded = await Promise.all(files.map(({ file, namespace }) => loadAgentFile(file, source, namespace)));
        for (const { agent, diagnostics: found } of loaded) {
            diagnostics.push(...found);
            if (!agent) {
                continue;
            }
            const winner = byName.get(agent.name);
            if (winner) {
                diagnostics.push({
                    severity: 'info',
                    message: `agent "${agent.name}" is overridden by ${winner.file}`,
                    file: agent.file,
                });
                continue;
            }
            byName.set(agent.name, agent);
        }
    }
    return { agents: [...byName.values()], diagnostics };
}
