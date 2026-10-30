import { type AutonomyLevel, DEFAULT_AUTONOMY } from './autonomy.ts';
import {
    CODER_PROMPT,
    DEBUGGER_PROMPT,
    ORG_PROMPT,
    PLAN_REVIEWER_PROMPT,
    PLANNER_PROMPT,
    REVIEWER_PROMPT,
    SCOUT_PROMPT,
    SPECIALIST_PROMPT,
    SUPERVISOR_PROMPT,
    TESTER_PROMPT,
    WRITER_PROMPT,
} from './default-prompts.ts';
import { type Currency, TIERS, type Tier } from './schemas.ts';
import { deepFreeze } from './util.ts';

/** Team roles (06 §2). */
export const ROLES = ['supervisor', 'planner', 'plan_reviewer', 'scout', 'executor', 'reviewer', 'specialist'] as const;
export type Role = (typeof ROLES)[number];

/** Host permission modes (10 §2): ask, auto-edit, plan (read-only) and full. */
export const PERMISSION_MODES = ['ask', 'auto_edit', 'plan', 'full'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Reasoning effort, with the same levels as `@xora/providers`. */
export const EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
/** `auto`: the host picks per task (the economy tier's "按任务定" in 06 §3). */
export type TierEffort = Effort | 'auto';

/** One model of a tier's fallback chain. Model ids only; the host binds them to the user's connections. */
export interface ModelChainEntry {
    /** Pins the entry to one connection; otherwise every connection serving `model` qualifies. */
    readonly connectionId?: string;
    readonly presetId?: string;
    readonly model: string;
    /** Model family for cross-family review; inferred from the model id when absent. */
    readonly family?: string;
    /** Overrides the tier's effort for this model, e.g. glm cannot turn thinking off. */
    readonly effort?: Effort;
}

export interface TierSpec {
    /** Fallback chain, first choice first (06 §3 rule 2). */
    readonly models: readonly ModelChainEntry[];
    readonly effort: TierEffort;
}

export type TierTable = Readonly<Record<Tier, TierSpec>>;

/** Spending limits in one currency; any limit may be absent. */
export interface BudgetLimits {
    readonly currency: Currency;
    /** One team run, i.e. one goal. */
    readonly perRun?: number;
    /** Default for a task card that sets no budget of its own. */
    readonly perTask?: number;
    /** Per local day. */
    readonly daily?: number;
}

export interface AgentSpec {
    readonly id: string;
    readonly name: string;
    readonly role: Role;
    /** Executor category such as `coding`, matched against task cards. */
    readonly category?: string;
    readonly tier: Tier;
    /** One line for the supervisor's roster: what the agent is good at. */
    readonly description?: string;
    /** Agent layer of the prompt (06 §4 layer 5). */
    readonly prompt: string;
    /** Tool whitelist the host enforces; absent means {@link ROLE_TOOLS} of the role. */
    readonly tools?: readonly string[];
    readonly mode: PermissionMode;
    /** Only the supervisor delegates (06 §9: no recursive delegation). */
    readonly canDelegate: boolean;
    /** Prefer a model family different from the executor's (reviews and plan reviews, 06 §3 rule 6). */
    readonly crossFamily?: boolean;
    readonly budget?: BudgetLimits;
}

export interface Organization {
    readonly id: string;
    readonly name: string;
    /** Organization layer of every member's prompt: the body of `org.md` (06 §4 layer 3). */
    readonly prompt: string;
    readonly tiers: TierTable;
    readonly roster: readonly AgentSpec[];
    readonly budgets: BudgetLimits;
    readonly autonomy: AutonomyLevel;
    /** Supervisor share of the cost above which the team view warns (06 §5). */
    readonly supervisionAlertRatio: number;
}

export const DEFAULT_SUPERVISION_ALERT_RATIO = 0.25;

/** Default tier of each role (06 §2). */
export const ROLE_TIERS: Readonly<Record<Role, Tier>> = {
    supervisor: 'flagship',
    planner: 'flagship',
    plan_reviewer: 'flagship',
    scout: 'fast',
    executor: 'economy',
    reviewer: 'standard',
    specialist: 'flagship',
};

/** Default permission mode of each role: read-only except executors and specialists. */
export const ROLE_MODES: Readonly<Record<Role, PermissionMode>> = {
    supervisor: 'plan',
    planner: 'plan',
    plan_reviewer: 'plan',
    scout: 'plan',
    executor: 'auto_edit',
    reviewer: 'plan',
    specialist: 'ask',
};

/** Team tools of the xora engine (06 §16). */
export const TEAM_TOOLS = {
    supervisor: [
        'task_create',
        'task_assign',
        'task_update',
        'task_list',
        'send_message',
        'ledger_update',
        'request_review',
    ],
    member: ['deliver', 'escalate', 'ask_supervisor'],
} as const;

const READ_TOOLS = ['read', 'list', 'glob', 'grep'];
const EDIT_TOOLS = ['write', 'edit', 'apply_patch'];
const WEB_TOOLS = ['web_fetch', 'web_search'];

/** Default tool whitelist of each role. The supervisor reads and delegates; it never writes (06 §2). */
export const ROLE_TOOLS: Readonly<Record<Role, readonly string[]>> = deepFreeze({
    supervisor: [...READ_TOOLS, 'todo', ...TEAM_TOOLS.supervisor],
    planner: [...READ_TOOLS, 'bash', ...WEB_TOOLS, ...TEAM_TOOLS.member],
    plan_reviewer: [...READ_TOOLS, ...TEAM_TOOLS.member],
    scout: [...READ_TOOLS, 'bash', ...WEB_TOOLS, ...TEAM_TOOLS.member],
    executor: [...READ_TOOLS, ...EDIT_TOOLS, 'bash', 'todo', ...TEAM_TOOLS.member],
    reviewer: [...READ_TOOLS, 'bash', ...TEAM_TOOLS.member],
    specialist: [...READ_TOOLS, ...EDIT_TOOLS, 'bash', 'todo', ...WEB_TOOLS, ...TEAM_TOOLS.member],
});

const kimi = (model: string): ModelChainEntry => ({ model, family: 'kimi' });
const deepseek = (model: string): ModelChainEntry => ({ model, family: 'deepseek' });
const glm = (model: string): ModelChainEntry => ({ model, family: 'glm' });

/** Default model chains of 06 §3. */
export const DEFAULT_TIERS: TierTable = deepFreeze({
    flagship: { effort: 'high', models: [kimi('kimi-k3.1-pro'), deepseek('deepseek-v4-pro'), glm('glm-5.3')] },
    standard: { effort: 'high', models: [deepseek('deepseek-v4-pro'), glm('glm-5.3'), kimi('kimi-k3')] },
    economy: { effort: 'auto', models: [deepseek('deepseek-flash'), glm('glm-5.3-flash')] },
    // glm always thinks, so its fast-tier entry runs at low effort instead of off.
    fast: { effort: 'off', models: [deepseek('deepseek-flash'), { ...glm('glm-5.3-flash'), effort: 'low' }] },
});

type AgentDefaults = Pick<AgentSpec, 'id' | 'name' | 'role' | 'prompt' | 'description'> & Partial<AgentSpec>;

/** Fills an agent's tier, mode and delegation right from its role. */
export function agentFromRole(fields: AgentDefaults): AgentSpec {
    return {
        tier: ROLE_TIERS[fields.role],
        mode: ROLE_MODES[fields.role],
        ...fields,
        canDelegate: fields.role === 'supervisor',
    };
}

/** The built-in organization (06 §2–§3, §14): ready to use, every role and tier filled in. */
export const DEFAULT_ORG: Organization = deepFreeze({
    id: 'default',
    name: 'Default team',
    prompt: ORG_PROMPT,
    tiers: DEFAULT_TIERS,
    budgets: { currency: 'CNY' },
    autonomy: DEFAULT_AUTONOMY,
    supervisionAlertRatio: DEFAULT_SUPERVISION_ALERT_RATIO,
    roster: [
        agentFromRole({
            id: 'supervisor',
            name: 'Supervisor',
            role: 'supervisor',
            description: 'Clarifies the goal, plans, delegates, accepts and reports; never edits files.',
            prompt: SUPERVISOR_PROMPT,
        }),
        agentFromRole({
            id: 'planner',
            name: 'Planner',
            role: 'planner',
            description: 'Drafts the approach, task graph and cards for complex goals.',
            prompt: PLANNER_PROMPT,
        }),
        agentFromRole({
            id: 'plan-reviewer',
            name: 'Plan reviewer',
            role: 'plan_reviewer',
            crossFamily: true,
            description: 'Audits a plan once, with a model family other than the planner.',
            prompt: PLAN_REVIEWER_PROMPT,
        }),
        agentFromRole({
            id: 'scout',
            name: 'Scout',
            role: 'scout',
            description: 'Reads code, docs and the web; returns facts with references.',
            prompt: SCOUT_PROMPT,
        }),
        agentFromRole({
            id: 'coder',
            name: 'Coder',
            role: 'executor',
            category: 'coding',
            description: 'Implements one task card in its own worktree.',
            prompt: CODER_PROMPT,
        }),
        agentFromRole({
            id: 'tester',
            name: 'Tester',
            role: 'executor',
            category: 'testing',
            description: 'Writes and fixes tests, including failing reproductions.',
            prompt: TESTER_PROMPT,
        }),
        agentFromRole({
            id: 'writer',
            name: 'Writer',
            role: 'executor',
            category: 'docs',
            description: 'Writes readmes, design notes and comments that match the code.',
            prompt: WRITER_PROMPT,
        }),
        agentFromRole({
            id: 'debugger',
            name: 'Debugger',
            role: 'executor',
            category: 'bugfix',
            tier: 'standard',
            mode: 'ask',
            description: 'Reproduces, locates, fixes and verifies one bug.',
            prompt: DEBUGGER_PROMPT,
        }),
        agentFromRole({
            id: 'reviewer',
            name: 'Reviewer',
            role: 'reviewer',
            crossFamily: true,
            description: 'Reviews a deliverable against its evidence, adversarially.',
            prompt: REVIEWER_PROMPT,
        }),
        agentFromRole({
            id: 'specialist',
            name: 'Specialist',
            role: 'specialist',
            description: 'Takes hard problems and tasks escalated from lower tiers.',
            prompt: SPECIALIST_PROMPT,
        }),
    ],
});

const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^(kimi|moonshot|k\d)/, 'kimi'],
    [/^deepseek/, 'deepseek'],
    [/^(glm|chatglm|zhipu)/, 'glm'],
    [/^(qwen|qwq)/, 'qwen'],
    [/^(minimax|abab)/, 'minimax'],
    [/^(doubao|seed)/, 'doubao'],
    [/^(gpt|chatgpt|codex|o\d)/, 'openai'],
    [/^claude/, 'anthropic'],
    [/^gemini/, 'google'],
    [/^grok/, 'xai'],
    [/^(mistral|codestral|devstral|magistral)/, 'mistral'],
    [/^llama/, 'llama'],
];

/** Model family from a model id such as `kimi-k3.1-pro`, `k3.1-pro` (kimi code) or `qwen3:32b`. */
export function inferFamily(model: string): string | undefined {
    const id = model.trim().toLowerCase();
    // Router-style ids (`vendor/model`) are judged by the model part first.
    const candidates = [id.slice(id.lastIndexOf('/') + 1), id];
    for (const candidate of candidates) {
        for (const [pattern, family] of FAMILY_PATTERNS) {
            if (pattern.test(candidate)) {
                return family;
            }
        }
    }
    return undefined;
}

/** Family of a chain entry: explicit, else inferred from the model id. */
export function familyOf(entry: Pick<ModelChainEntry, 'model' | 'family'>): string | undefined {
    return entry.family ?? inferFamily(entry.model);
}

/**
 * The roster entry for an agent id, an agent name, or an instance id such as `coder-2` started from the
 * `coder` spec.
 */
export function findAgent(org: Organization, idOrName: string): AgentSpec | undefined {
    const key = idOrName.trim();
    const lower = key.toLowerCase();
    return (
        org.roster.find((agent) => agent.id === key) ??
        org.roster.find((agent) => agent.name.toLowerCase() === lower) ??
        org.roster.find((agent) => agent.id === key.replace(/-\d+$/, ''))
    );
}

/** Agents with `role`, and with `category` when given (falling back to any agent of the role). */
export function agentsWithRole(org: Organization, role: Role, category?: string): AgentSpec[] {
    const all = org.roster.filter((agent) => agent.role === role);
    if (category === undefined) {
        return all;
    }
    const matching = all.filter((agent) => agent.category === category.toLowerCase());
    return matching.length > 0 ? matching : all;
}

/** Tools an agent may use: its own whitelist, else its role's defaults. */
export function toolsOf(agent: AgentSpec): readonly string[] {
    return agent.tools ?? ROLE_TOOLS[agent.role];
}

export type OrgIssueCode =
    | 'missing_supervisor'
    | 'multiple_supervisors'
    | 'duplicate_agent'
    | 'recursive_delegation'
    | 'empty_tier'
    | 'invalid_alert_ratio';

export interface OrgIssue {
    readonly code: OrgIssueCode;
    readonly message: string;
    readonly agentId?: string;
}

/** Structural problems that would break a team run. An empty list means the organization is usable. */
export function validateOrganization(org: Organization): OrgIssue[] {
    const issues: OrgIssue[] = [];
    const supervisors = org.roster.filter((agent) => agent.role === 'supervisor');
    if (supervisors.length === 0) {
        issues.push({ code: 'missing_supervisor', message: 'the roster has no supervisor' });
    } else if (supervisors.length > 1) {
        issues.push({
            code: 'multiple_supervisors',
            message: `the roster has ${supervisors.length} supervisors; a team has one`,
        });
    }
    const seen = new Set<string>();
    for (const agent of org.roster) {
        if (seen.has(agent.id)) {
            issues.push({ code: 'duplicate_agent', message: `agent id ${agent.id} is used twice`, agentId: agent.id });
        }
        seen.add(agent.id);
        if (agent.canDelegate && agent.role !== 'supervisor') {
            issues.push({
                code: 'recursive_delegation',
                message: `${agent.id} is a ${agent.role} and may not delegate; only the supervisor does`,
                agentId: agent.id,
            });
        }
    }
    for (const tier of TIERS) {
        if (org.tiers[tier].models.length === 0) {
            issues.push({ code: 'empty_tier', message: `tier ${tier} has no models` });
        }
    }
    if (!(org.supervisionAlertRatio > 0 && org.supervisionAlertRatio <= 1)) {
        issues.push({ code: 'invalid_alert_ratio', message: 'supervisionAlertRatio must be in (0, 1]' });
    }
    return issues;
}
