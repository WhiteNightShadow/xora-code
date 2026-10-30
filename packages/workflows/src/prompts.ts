import { type AutonomyAction, type AutonomyLevel, confirmationPoints } from './autonomy.ts';
import { DELIVERABLE_CONTRACT } from './default-prompts.ts';
import type { AgentSpec, Organization, PermissionMode } from './org.ts';
import type { AcceptanceCheck, StructuredParseError, TaskCard } from './schemas.ts';
import { tidyText } from './util.ts';

/**
 * The team's prompt layers (06 §4, 08 §1.2). This package renders the organization, roster and agent layers
 * for the system prompt and the task layer for the first user message; the host adds its own layers (system,
 * user global, project, session, environment) around them in {@link LAYER_ORDER}. Layers depend only on their
 * inputs, so agents of the same organization and spec get byte-identical system layers and share the prefix
 * cache.
 */

/** Every layer in assembly order (08 §1.2). */
export const LAYER_ORDER = [
    'system',
    'user_global',
    'org',
    'roster',
    'project',
    'project_private',
    'agent',
    'session',
    'task',
    'environment',
    'input',
] as const;
export type LayerId = (typeof LAYER_ORDER)[number];

export interface PromptLayer {
    readonly id: Extract<LayerId, 'org' | 'roster' | 'agent' | 'task'>;
    /** `system` for layers 3–5, `user` for the task layer, which goes into the first user message. */
    readonly placement: 'system' | 'user';
    /** Where the content came from, for "view effective prompt". */
    readonly source: string;
    /** The layer wrapped in its tag. */
    readonly text: string;
}

/** The supervisor's goal and run settings, rendered into its first user message. */
export interface TeamGoal {
    readonly text: string;
    readonly autonomy?: AutonomyLevel;
    readonly budget?: { readonly limit: number; readonly currency: string };
}

export interface AgentLayerInput {
    readonly org: Organization;
    readonly agent: AgentSpec;
    /** The card this agent works. */
    readonly card?: TaskCard;
    /** Lines handed over from an earlier attempt, e.g. an escalated executor's findings (06 §7). */
    readonly handoff?: readonly string[];
    /** The team goal, for the supervisor. */
    readonly goal?: TeamGoal;
}

/**
 * Ordered layers for one agent: organization, roster (supervisor only), agent, then task and goal for the first
 * user message.
 */
export function buildAgentLayers(input: AgentLayerInput): PromptLayer[] {
    const { org, agent } = input;
    const layers: PromptLayer[] = [
        {
            id: 'org',
            placement: 'system',
            source: `org:${org.id}`,
            text: tag('org_instructions', { org: org.id }, org.prompt),
        },
    ];
    if (agent.role === 'supervisor') {
        layers.push({
            id: 'roster',
            placement: 'system',
            source: `org:${org.id}:roster`,
            text: tag('team_roster', { org: org.id }, renderRosterSummary(org)),
        });
    }
    layers.push({
        id: 'agent',
        placement: 'system',
        source: `agent:${agent.id}`,
        text: tag('agent_instructions', { name: agent.name, role: agent.role }, agent.prompt),
    });
    if (input.goal) {
        layers.push({ id: 'task', placement: 'user', source: 'goal', text: renderTeamGoal(input.goal) });
    }
    if (input.card) {
        layers.push({
            id: 'task',
            placement: 'user',
            source: `task:${input.card.id}`,
            text: renderTaskCard(input.card, { handoff: input.handoff }),
        });
    }
    return layers;
}

/** System prompt text of the layers that go there, joined in order. */
export function systemText(layers: readonly PromptLayer[]): string {
    return layers
        .filter((layer) => layer.placement === 'system')
        .map((layer) => layer.text)
        .join('\n\n');
}

function escapeAttribute(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function tag(name: string, attributes: Readonly<Record<string, string>>, body: string): string {
    const attrs = Object.entries(attributes)
        .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
        .join('');
    return `<${name}${attrs}>\n${tidyText(body)}\n</${name}>`;
}

const MODE_LABELS: Readonly<Record<PermissionMode, string>> = {
    plan: 'read-only',
    ask: 'asks before edits',
    auto_edit: 'edits its workspace',
    full: 'full access',
};

/** The first sentence of a prompt, for agents without a description. */
function firstSentence(text: string): string {
    const line = tidyText(text).split('\n')[0] ?? '';
    const match = /^(.+?[.!?])(\s|$)/.exec(line);
    const sentence = match?.[1] ?? line;
    return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/** Who the supervisor can assign work to, what each is good at and which tier it runs at. */
export function renderRosterSummary(org: Organization): string {
    const lines = ['Members you can assign, by id. Pick by role and category; the tier sets model strength and cost.'];
    for (const agent of org.roster) {
        if (agent.role === 'supervisor') {
            continue;
        }
        const role = agent.category ? `${agent.role} (${agent.category})` : agent.role;
        const traits = [role, agent.tier, MODE_LABELS[agent.mode], ...(agent.crossFamily ? ['cross-family'] : [])];
        lines.push(`- ${agent.id}: ${traits.join(', ')}. ${agent.description ?? firstSentence(agent.prompt)}`);
    }
    lines.push(
        'Tiers, strongest first: flagship (supervision, planning, hard problems), standard (complex work, ' +
            'review), economy (routine implementation, tests, docs), fast (scouting, search, summaries).',
    );
    return lines.join('\n');
}

function describeCheck(check: AcceptanceCheck): string {
    if (check.type === 'command') {
        return check.expect === 'fail'
            ? `Command must fail (reproduction): \`${check.run}\``
            : `Command must pass: \`${check.run}\``;
    }
    return check.type === 'review' ? `Review by ${check.by}` : `Manual check: ${check.note}`;
}

function list(title: string, items: readonly string[]): string[] {
    return items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];
}

export interface RenderTaskCardOptions {
    /** Lines handed over from an earlier attempt. */
    readonly handoff?: readonly string[];
}

/** The task card as a compact text block for the first user message (06 §4 layer 6). */
export function renderTaskCard(card: TaskCard, options: RenderTaskCardOptions = {}): string {
    const facts = [
        `Category: ${card.category}`,
        `Tier: ${card.tier}`,
        `Workspace: ${card.workspace}`,
        ...(card.priority ? [`Priority: ${card.priority}`] : []),
    ];
    const context = [
        ...card.context.files.map((file) => `File: ${file}`),
        ...card.context.facts.map((fact) => `Fact: ${fact}`),
        ...card.context.links.map((link) => `Link: ${link}`),
    ];
    const ownership =
        card.workspace === 'readonly'
            ? ['Ownership: none; this task is read-only, change nothing.']
            : card.ownership.length === 0
              ? ['Ownership: not set; ask the supervisor before changing any file.']
              : list('Ownership (change only files matching these)', card.ownership);
    const budget = [
        `${card.budget.cost} ${card.budget.currency}`,
        ...(card.budget.maxTurns === undefined ? [] : [`at most ${card.budget.maxTurns} turns`]),
    ];
    const artifacts = card.deliverable.artifacts.length > 0 ? ` (${card.deliverable.artifacts.join(', ')})` : '';
    const lines = [
        `Title: ${card.title}`,
        `Goal: ${card.goal}`,
        facts.join(' | '),
        ...(card.tierReason ? [`Tier reason: ${card.tierReason}`] : []),
        ...(card.assignee ? [`Assignee: ${card.assignee}`] : []),
        ...(card.dependsOn.length > 0 ? [`Depends on: ${card.dependsOn.join(', ')}`] : []),
        ...list('Context', context),
        ...ownership,
        ...list('Constraints', card.constraints),
        'Acceptance:',
        ...card.acceptance.map((check, index) => `${index + 1}. ${describeCheck(check)}`),
        `Deliverable: ${card.deliverable.kind}${artifacts}`,
        `Budget: ${budget.join(', ')}`,
        ...list('Handoff from the previous attempt', options.handoff ?? []),
    ];
    return tag('task_card', { id: card.id }, lines.join('\n'));
}

const CONFIRMATION_LABELS: Readonly<Record<AutonomyAction, string>> = {
    every_step: 'every step',
    plan_approval: 'the plan',
    high_risk: 'high-risk actions',
    final_delivery: 'the final delivery',
};

/** The supervisor's goal block: the goal, what the user confirms at the run's autonomy level, and the budget. */
export function renderTeamGoal(goal: TeamGoal): string {
    const lines = [`Goal: ${goal.text}`];
    if (goal.autonomy) {
        const points = confirmationPoints(goal.autonomy).map((point) => CONFIRMATION_LABELS[point]);
        lines.push(`Autonomy: ${goal.autonomy}; the user confirms ${points.join(', ')}.`);
    }
    if (goal.budget) {
        lines.push(`Budget: ${goal.budget.limit} ${goal.budget.currency} for this run.`);
    }
    return tag('team_goal', {}, lines.join('\n'));
}

/** Tail of an agent's output kept for repair: the deliverable sits at the end. */
const REPAIR_TAIL = 12_000;

export interface DeliverableRepairInput {
    readonly taskId: string;
    /** The agent's final message that could not be parsed. */
    readonly text: string;
    readonly error: StructuredParseError;
}

/**
 * The request that asks a reviewer to turn an unparseable final message into a deliverable (06 §16), e.g. from an
 * external agent. The reviewer must not add facts, so missing evidence stays missing and fails acceptance.
 */
export function renderDeliverableRepair(input: DeliverableRepairInput): string {
    const text = input.text.length > REPAIR_TAIL ? `...${input.text.slice(-REPAIR_TAIL)}` : input.text;
    const problems = input.error.issues.length > 0 ? input.error.issues : [input.error.message];
    const lines = [
        `The final message of the agent that worked task ${input.taskId} could not be read as a deliverable:`,
        ...problems.map((problem) => `- ${problem}`),
        'Rewrite it as the deliverable below. Use only what the message says: do not add evidence, changes or ' +
            'claims it does not contain, and use status "partial" when it does not show the task is done.',
        '',
        DELIVERABLE_CONTRACT,
    ];
    return `${lines.join('\n')}\n\n<agent_message task="${escapeAttribute(input.taskId)}">\n${text.trim()}\n</agent_message>`;
}
