import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AUTONOMY_LEVELS, type AutonomyLevel } from './autonomy.ts';
import { type FrontmatterValue, parseFrontmatter } from './frontmatter.ts';
import {
    type AgentSpec,
    type BudgetLimits,
    DEFAULT_ORG,
    EFFORTS,
    type ModelChainEntry,
    type Organization,
    PERMISSION_MODES,
    type PermissionMode,
    ROLE_MODES,
    ROLE_TIERS,
    ROLES,
    type Role,
    type TierEffort,
    type TierSpec,
    validateOrganization,
} from './org.ts';
import { type Currency, TIERS, type Tier } from './schemas.ts';
import { deepFreeze, tidyText } from './util.ts';

export interface LoadOrganizationOptions {
    /** User-level organization directory, `<data>/orgs/<org>/`, holding `org.md` and `agents/*.md`. */
    readonly userDir?: string;
    /** Project root. Its `.xora/org.md` and `.xora/agents/*.md` override the user level. */
    readonly projectDir?: string;
    /** Organization the files are applied to; {@link DEFAULT_ORG} when absent. */
    readonly base?: Organization;
}

export interface LoadedOrganization {
    readonly org: Organization;
    /** Files that were applied, in order. Empty when the result is the base organization. */
    readonly sources: readonly string[];
    /** Problems in the files; the affected values keep their previous setting. */
    readonly warnings: readonly string[];
}

/**
 * Loads an organization (06 §2): the base (built-in by default), then the user level, then the project level.
 * `org.md` frontmatter sets `id`, `name`, `autonomy`, `supervisionAlertRatio`, `budgets.*`, `tiers.<tier>`
 * (a model list, e.g. `kimi-k3.1-pro, deepseek-v4-pro`; `model(low)` sets one model's effort) and
 * `effort.<tier>`; its body replaces the organization prompt. Each `agents/*.md` overrides the agent with the
 * same id (frontmatter `id` or the file name) or name, or adds a new one; `disabled: true` removes it.
 */
export async function loadOrganization(options: LoadOrganizationOptions): Promise<LoadedOrganization> {
    const base = options.base ?? DEFAULT_ORG;
    let org: Organization = base;
    const sources: string[] = [];
    const warnings: string[] = [];
    const layers: Array<{ dir: string; id?: string }> = [];
    if (options.userDir !== undefined) {
        layers.push({ dir: options.userDir, id: basename(options.userDir) });
    }
    if (options.projectDir !== undefined) {
        layers.push({ dir: join(options.projectDir, '.xora') });
    }
    for (const layer of layers) {
        const orgFile = join(layer.dir, 'org.md');
        const orgText = await readOptional(orgFile, warnings);
        const agentFiles = await listMarkdown(join(layer.dir, 'agents'), warnings);
        if (layer.id !== undefined && (orgText !== undefined || agentFiles.length > 0)) {
            org = { ...org, id: layer.id };
        }
        if (orgText !== undefined) {
            org = applyOrgFile(org, orgText, orgFile, warnings);
            sources.push(orgFile);
        }
        for (const file of agentFiles) {
            const text = await readOptional(file, warnings);
            if (text !== undefined) {
                org = applyAgentFile(org, text, file, base, warnings);
                sources.push(file);
            }
        }
    }
    if (sources.length === 0) {
        return { org: base, sources, warnings };
    }
    for (const issue of validateOrganization(org)) {
        if (issue.code === 'missing_supervisor') {
            const supervisor = base.roster.find((agent) => agent.role === 'supervisor');
            if (supervisor) {
                org = { ...org, roster: [supervisor, ...org.roster] };
                warnings.push('the roster lost its supervisor; the built-in one was kept');
                continue;
            }
        }
        warnings.push(issue.message);
    }
    return { org: deepFreeze(org), sources, warnings };
}

async function readOptional(file: string, warnings: string[]): Promise<string | undefined> {
    try {
        return await readFile(file, 'utf8');
    } catch (error) {
        if (!isMissing(error)) {
            warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
    }
}

async function listMarkdown(dir: string, warnings: string[]): Promise<string[]> {
    try {
        const names = await readdir(dir);
        return names
            .filter((name) => name.toLowerCase().endsWith('.md'))
            .sort()
            .map((name) => join(dir, name));
    } catch (error) {
        if (!isMissing(error)) {
            warnings.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
    }
}

function isMissing(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

const ORG_KEYS = new Set(['id', 'name', 'autonomy', 'supervisionAlertRatio', 'budgets', 'tiers', 'effort']);
const AGENT_KEYS = new Set([
    'id',
    'name',
    'role',
    'category',
    'tier',
    'model',
    'description',
    'tools',
    'mode',
    'canDelegate',
    'crossFamily',
    'budget',
    'disabled',
]);
const TIER_EFFORTS: readonly TierEffort[] = [...EFFORTS, 'auto'];
const MODEL_ENTRY = /^(.*?)\s*\(\s*([a-z]+)\s*\)$/;

function applyOrgFile(org: Organization, text: string, file: string, warnings: string[]): Organization {
    const { data, body, errors } = parseFrontmatter(text);
    const warn = (message: string): void => {
        warnings.push(`${file}: ${message}`);
    };
    errors.forEach(warn);
    let next: Organization = { ...org };
    const id = asText(data.id);
    const name = asText(data.name);
    if (id !== undefined) {
        next = { ...next, id };
    }
    if (name !== undefined) {
        next = { ...next, name };
    }
    if (data.autonomy !== undefined) {
        const autonomy = asEnum(AUTONOMY_LEVELS, data.autonomy, 'autonomy', warn);
        if (autonomy !== undefined) {
            next = { ...next, autonomy: autonomy as AutonomyLevel };
        }
    }
    if (data.supervisionAlertRatio !== undefined) {
        const ratio = asRatio(data.supervisionAlertRatio);
        if (ratio === undefined) {
            warn('supervisionAlertRatio must be a number in (0, 1] or a percentage');
        } else {
            next = { ...next, supervisionAlertRatio: ratio };
        }
    }
    if (data.budgets !== undefined) {
        next = { ...next, budgets: asBudget(data.budgets, next.budgets, 'budgets', warn) ?? next.budgets };
    }
    const tiers: Record<Tier, TierSpec> = { ...next.tiers };
    for (const [key, value] of entriesOf(data.tiers, 'tiers', warn)) {
        const tier = asEnum(TIERS, key, 'tier', warn);
        const models = modelList(value);
        if (tier === undefined) {
            continue;
        }
        if (models.length === 0) {
            warn(`tiers.${tier} lists no models`);
        } else {
            tiers[tier] = { ...tiers[tier], models };
        }
    }
    for (const [key, value] of entriesOf(data.effort, 'effort', warn)) {
        const tier = asEnum(TIERS, key, 'tier', warn);
        const effort = asEnum(TIER_EFFORTS, value, `effort.${key}`, warn);
        if (tier !== undefined && effort !== undefined) {
            tiers[tier] = { ...tiers[tier], effort };
        }
    }
    next = { ...next, tiers };
    for (const key of Object.keys(data)) {
        if (!ORG_KEYS.has(key)) {
            warn(`unknown key "${key}"`);
        }
    }
    const prompt = tidyText(body);
    return prompt === '' ? next : { ...next, prompt };
}

function applyAgentFile(
    org: Organization,
    text: string,
    file: string,
    base: Organization,
    warnings: string[],
): Organization {
    const { data, body, errors } = parseFrontmatter(text);
    const warn = (message: string): void => {
        warnings.push(`${file}: ${message}`);
    };
    errors.forEach(warn);
    const id = asText(data.id) ?? basename(file).replace(/\.md$/i, '');
    const name = asText(data.name);
    let index = org.roster.findIndex((agent) => agent.id === id);
    if (index < 0 && name !== undefined) {
        index = org.roster.findIndex((agent) => agent.name.toLowerCase() === name.toLowerCase());
    }
    const previous = index >= 0 ? org.roster[index] : undefined;
    if (data.disabled === true) {
        return previous ? { ...org, roster: org.roster.filter((_, position) => position !== index) } : org;
    }
    const role = (asEnum(ROLES, data.role, 'role', warn) as Role | undefined) ?? previous?.role ?? 'executor';
    // A role change resets the role-derived defaults.
    const kept = previous?.role === role ? previous : undefined;
    const category = asText(data.category)?.toLowerCase() ?? kept?.category;
    const template =
        base.roster.find((agent) => agent.role === role && agent.category === category) ??
        base.roster.find((agent) => agent.role === role);
    if (data.canDelegate === true && role !== 'supervisor') {
        warn('only the supervisor may delegate; canDelegate is ignored');
    }
    const tools = data.tools === undefined ? undefined : asTextList(data.tools);
    const crossFamily = data.crossFamily === undefined ? kept?.crossFamily : asBoolean(data.crossFamily);
    const prompt = tidyText(body);
    const agent: AgentSpec = {
        id,
        name: name ?? previous?.name ?? id,
        role,
        category,
        tier: (asEnum(TIERS, data.tier, 'tier', warn) as Tier | undefined) ?? kept?.tier ?? ROLE_TIERS[role],
        ...(data.model !== undefined
            ? modelList(data.model).length > 0
                ? { models: modelList(data.model) }
                : {}
            : kept?.models
              ? { models: kept.models }
              : {}),
        description: asText(data.description) ?? kept?.description,
        prompt: prompt !== '' ? prompt : (kept?.prompt ?? template?.prompt ?? ''),
        tools: tools ?? kept?.tools,
        mode:
            (asEnum(PERMISSION_MODES, data.mode, 'mode', warn) as PermissionMode | undefined) ??
            kept?.mode ??
            ROLE_MODES[role],
        canDelegate: role === 'supervisor',
        crossFamily,
        budget:
            data.budget === undefined
                ? kept?.budget
                : asBudget(data.budget, kept?.budget ?? org.budgets, 'budget', warn),
    };
    if (agent.prompt === '') {
        warn(`agent ${id} has no prompt`);
    }
    for (const key of Object.keys(data)) {
        if (!AGENT_KEYS.has(key)) {
            warn(`unknown key "${key}"`);
        }
    }
    const roster = [...org.roster];
    if (index >= 0) {
        roster[index] = agent;
    } else {
        roster.push(agent);
    }
    return { ...org, roster };
}

function asText(value: FrontmatterValue | undefined): string | undefined {
    if (typeof value === 'string') {
        return value.trim() === '' ? undefined : value.trim();
    }
    return typeof value === 'number' ? String(value) : undefined;
}

function asBoolean(value: FrontmatterValue | undefined): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function asTextList(value: FrontmatterValue | undefined): string[] {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return items.map((item) => String(item ?? '').trim()).filter((item) => item !== '');
}

function asEnum<T extends string>(
    allowed: readonly T[],
    value: FrontmatterValue | string | undefined,
    label: string,
    warn: (message: string) => void,
): T | undefined {
    if (value === undefined) {
        return undefined;
    }
    const text = typeof value === 'string' ? value.trim() : String(value);
    const found = allowed.find((option) => option.toLowerCase() === text.toLowerCase());
    if (found === undefined) {
        warn(`${label} "${text}" is not one of ${allowed.join(', ')}`);
    }
    return found;
}

function asRatio(value: FrontmatterValue): number | undefined {
    let ratio: number | undefined;
    if (typeof value === 'number') {
        ratio = value;
    } else if (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value.trim())) {
        ratio = Number.parseFloat(value) / 100;
    }
    return ratio !== undefined && ratio > 0 && ratio <= 1 ? ratio : undefined;
}

function entriesOf(
    value: FrontmatterValue | undefined,
    label: string,
    warn: (message: string) => void,
): Array<[string, FrontmatterValue]> {
    if (value === undefined) {
        return [];
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        warn(`${label} must be a map, e.g. ${label}.flagship: …`);
        return [];
    }
    return Object.entries(value);
}

function asBudget(
    value: FrontmatterValue,
    previous: BudgetLimits,
    label: string,
    warn: (message: string) => void,
): BudgetLimits | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        warn(`${label} must be a map such as ${label}.perRun: 20`);
        return undefined;
    }
    let budget: BudgetLimits = { ...previous };
    for (const [key, raw] of Object.entries(value)) {
        if (key === 'currency') {
            const currency = asEnum<Currency>(['CNY', 'USD'], raw, `${label}.currency`, warn);
            budget = currency === undefined ? budget : { ...budget, currency };
        } else if (key === 'perRun' || key === 'perTask' || key === 'daily') {
            if (typeof raw === 'number' && raw >= 0) {
                budget = { ...budget, [key]: raw };
            } else {
                warn(`${label}.${key} must be a non-negative number`);
            }
        } else {
            warn(`unknown key "${label}.${key}"`);
        }
    }
    return budget;
}

/** `kimi-k3.1-pro, deepseek-v4-pro` or a list; `model(low)` sets that model's effort. Arrows also separate. */
function modelList(value: FrontmatterValue): ModelChainEntry[] {
    const items = Array.isArray(value)
        ? value.map((item) => String(item ?? ''))
        : typeof value === 'string'
          ? value.split(/\s*(?:,|→|->)\s*/)
          : [];
    const entries: ModelChainEntry[] = [];
    for (const item of items) {
        const trimmed = item.trim();
        if (trimmed === '') {
            continue;
        }
        const match = MODEL_ENTRY.exec(trimmed);
        const effort = EFFORTS.find((level) => level === match?.[2]);
        entries.push(match && effort ? { model: (match[1] ?? '').trim(), effort } : { model: trimmed });
    }
    return entries;
}
