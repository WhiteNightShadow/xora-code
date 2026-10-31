import { existsSync } from 'node:fs';
import path from 'node:path';
import {
    type AgentSpec,
    agentsWithRole,
    type BoardTask,
    buildAgentLayers,
    type CommandResult,
    type Deliverable,
    DeliverableSchema,
    findAgent,
    type LoadedOrganization,
    loadOrganization,
    needsHuman,
    type Organization,
    type Role,
    renderTaskCard,
    renderTeamGoal,
    resolveTier,
    TASK_STATUSES,
    type TaskBoard,
    type TaskCard,
    TaskCardSchema,
    type TeamRun,
    TierSchema,
    toolsOf,
} from '@xora/workflows';
import { z } from 'zod';
import type { HostToolProvider } from './turns.ts';

/**
 * What the members of a team run see (06 §4, §16): the team tools with their schemas, the prompt layers and tool
 * whitelists of each agent, the host's messages to the supervisor and executors, and the organization in force.
 */

/** The engine's built-in tools; a role's whitelist hides the others (06 §4: enforced by the host, not prompts). */
const BUILTIN_TOOLS = [
    'read',
    'list',
    'glob',
    'grep',
    'edit',
    'multi_edit',
    'write',
    'apply_patch',
    'bash',
    'bash_output',
    'bash_kill',
    'todo',
];
/** Built-ins that come with a whitelisted one. */
const COMPANION_TOOLS: Readonly<Record<string, readonly string[]>> = {
    edit: ['multi_edit'],
    bash: ['bash_output', 'bash_kill'],
};
/** Card categories a read-only card hands to a scout rather than an executor. */
const SCOUT_CATEGORIES = new Set([
    'scout',
    'scouting',
    'research',
    'search',
    'investigation',
    'exploration',
    'explore',
]);
const LAYER_IDS: Readonly<Record<string, string>> = {
    org: 'org_instructions',
    roster: 'team_roster',
    agent: 'agent_instructions',
};

// ---------------------------------------------------------------------------------------------------------
// Tools

function tidySchema(node: unknown): unknown {
    if (Array.isArray(node)) {
        return node.map(tidySchema);
    }
    if (node === null || typeof node !== 'object') {
        return node;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        const safeBound =
            (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) ||
            (key === 'minimum' && value === Number.MIN_SAFE_INTEGER);
        if (!safeBound && key !== '$schema') {
            result[key] = tidySchema(value);
        }
    }
    return result;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
    return tidySchema(z.toJSONSchema(schema, { io: 'input' })) as Record<string, unknown>;
}

export const TaskAssignInput = z.object({
    taskId: z.string().min(1),
    assignee: z.string().min(1).optional().describe('Roster member id, e.g. coder; by category when absent'),
    tier: TierSchema.optional(),
    tierReason: z.string().min(1).optional().describe('Required for a tier above the member’s default'),
});
export const TaskUpdateInput = z.object({
    taskId: z.string().min(1),
    changes: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Card fields to change; only for pending, ready, blocked or failed tasks'),
    status: z
        .enum(['cancelled', 'ready'])
        .optional()
        .describe('cancelled: drop the task; ready: retry a failed task or continue a blocked one'),
    reason: z.string().min(1).optional(),
});
export const TaskListInput = z.object({ status: z.array(z.enum(TASK_STATUSES)).optional() });
export const SendMessageInput = z.object({
    to: z.string().min(1).describe('Task id, or the member id holding a task'),
    text: z.string().min(1),
});
export const LedgerUpdateInput = z.object({
    reason: z.string().min(1).describe('Why the plan changes; kept with the revision'),
    goal: z.string().min(1).optional(),
    plan: z.string().optional().describe('The approach, in prose'),
    facts: z.array(z.string()).optional(),
    assumptions: z.array(z.string()).optional(),
    decisions: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    replace: z.boolean().optional().describe('Replace the list fields instead of appending to them'),
    progress: z
        .object({
            complete: z.boolean().optional(),
            progressing: z.boolean(),
            looping: z.boolean().optional(),
            nextAssignee: z.string().optional(),
            instruction: z.string().optional(),
            reason: z.string().min(1),
        })
        .optional()
        .describe('Your own progress check, recorded in the progress ledger'),
});
export const RequestReviewInput = z.object({ taskId: z.string().min(1), focus: z.string().optional() });
export const EscalateInput = z.object({
    to: TierSchema.optional().describe('The tier to hand the card to; the next tier up by default'),
    reason: z.string().min(1),
    findings: z.array(z.string()).optional().describe('What you learned, so the next agent does not start over'),
});
export const AskInput = z.object({ question: z.string().min(1) });

function deliverSchema(): Record<string, unknown> {
    const schema = jsonSchema(DeliverableSchema);
    if (Array.isArray(schema.required)) {
        schema.required = schema.required.filter((key) => key !== 'taskId');
    }
    return schema;
}

type ToolSpec = HostToolProvider['tools'][number];

/** `TEAM_TOOLS.supervisor` of the workflows package, implemented by the host. */
export const SUPERVISOR_TOOLS: readonly ToolSpec[] = [
    {
        name: 'task_create',
        description:
            'Create task cards. Cards in one call may depend on each other; all are added or none. Every card needs ' +
            'acceptance checks, and a writable card (workspace worktree or local) needs ownership globs. Errors come ' +
            'back with the reason: fix the cards and call again. Cards are dispatched automatically once the plan is ' +
            'approved and their dependencies are done.',
        parameters: jsonSchema(z.object({ tasks: z.array(TaskCardSchema).min(1) })),
        kind: 'other',
    },
    {
        name: 'task_assign',
        description:
            'Choose the member (and optionally a tier) for a task that is not running, or put a failed, blocked or ' +
            'supervisor-held task back in the queue.',
        parameters: jsonSchema(TaskAssignInput),
        kind: 'other',
    },
    {
        name: 'task_update',
        description:
            'Change a task card that is not running, cancel a task, or set a failed or blocked task back to ready.',
        parameters: jsonSchema(TaskUpdateInput),
        kind: 'other',
    },
    {
        name: 'task_list',
        description: 'The board: every task with status, tier, owner, dependencies, latest deliverable and verdict.',
        parameters: jsonSchema(TaskListInput),
        kind: 'read',
    },
    {
        name: 'send_message',
        description: 'Message the member working a task: answers its pending question, or reaches it at its next turn.',
        parameters: jsonSchema(SendMessageInput),
        kind: 'other',
    },
    {
        name: 'ledger_update',
        description:
            'Revise the task ledger (goal, facts, assumptions, plan, decisions, risks); every revision is kept. ' +
            'Optionally record a progress check.',
        parameters: jsonSchema(LedgerUpdateInput),
        kind: 'other',
    },
    {
        name: 'request_review',
        description:
            'Have a reviewer of another model family check a task’s latest deliverable; the verdict arrives in a ' +
            'team update.',
        parameters: jsonSchema(RequestReviewInput),
        kind: 'other',
    },
];

/** `TEAM_TOOLS.member` of the workflows package, implemented by the host. */
export const MEMBER_TOOLS: readonly ToolSpec[] = [
    {
        name: 'deliver',
        description:
            'Hand in the deliverable of your task card (taskId may be left out). Then end your turn: the host runs ' +
            'the acceptance checks.',
        parameters: deliverSchema(),
        kind: 'other',
    },
    {
        name: 'escalate',
        description: 'Hand the card to a stronger tier with your findings when it is beyond you. Then end your turn.',
        parameters: jsonSchema(EscalateInput),
        kind: 'other',
    },
    {
        name: 'ask_supervisor',
        description:
            'Ask the supervisor what the card and the code cannot answer; waits for the answer. Not for permission: ' +
            'a message is never the user’s approval.',
        parameters: jsonSchema(AskInput),
        kind: 'other',
    },
];

// ---------------------------------------------------------------------------------------------------------
// Agents

export function shorten(text: string, length: number): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > length ? `${line.slice(0, length)}…` : line;
}

/** Strips the tag `buildAgentLayers` wraps a layer in; the engine wraps layers itself. */
function untag(text: string): string {
    return text.replace(/^<[^>\n]+>\n/, '').replace(/\n<\/[a-z_]+>$/, '');
}

/** Organization, roster (supervisor only) and agent layers for the system prompt (06 §4 layers 3–5). */
export function systemLayers(org: Organization, agent: AgentSpec): NonNullable<HostToolProvider['layers']> {
    return buildAgentLayers({ org, agent })
        .filter((layer) => layer.placement === 'system')
        .map((layer) => ({
            id: LAYER_IDS[layer.id] ?? layer.id,
            title:
                layer.id === 'org' ? `组织：${org.name}` : layer.id === 'roster' ? '团队名册' : `agent：${agent.name}`,
            text: untag(layer.text),
        }));
}

/** Built-ins outside the agent's whitelist. */
export function disabledBuiltins(agent: AgentSpec): string[] {
    const allowed = new Set<string>();
    for (const tool of toolsOf(agent)) {
        allowed.add(tool);
        for (const companion of COMPANION_TOOLS[tool] ?? []) {
            allowed.add(companion);
        }
    }
    return BUILTIN_TOOLS.filter((tool) => !allowed.has(tool));
}

/** The role a card's work goes to: its assignee's, a scout for read-only research, else an executor. */
export function roleFor(org: Organization, card: Pick<TaskCard, 'assignee' | 'category' | 'workspace'>): Role {
    const assigned = card.assignee ? findAgent(org, card.assignee) : undefined;
    if (assigned && assigned.role !== 'supervisor') {
        return assigned.role;
    }
    return card.workspace === 'readonly' && SCOUT_CATEGORIES.has(card.category.toLowerCase()) ? 'scout' : 'executor';
}

/** The member a task goes to (06 §2): its assignee, else by role and category; flagship work to a specialist. */
export function agentFor(org: Organization, task: BoardTask): AgentSpec {
    const specialist = agentsWithRole(org, 'specialist')[0];
    if ((task.handler === 'supervisor' || (task.tier === 'flagship' && task.attempts.length > 0)) && specialist) {
        return specialist;
    }
    const assigned = task.card.assignee ? findAgent(org, task.card.assignee) : undefined;
    if (assigned && assigned.role !== 'supervisor') {
        return assigned;
    }
    const agent =
        agentsWithRole(org, roleFor(org, task.card), task.card.category)[0] ?? agentsWithRole(org, 'executor')[0];
    if (agent) {
        return agent;
    }
    return specialist ?? (org.roster.find((member) => member.role !== 'supervisor') as AgentSpec);
}

/** Host gates on top of the board's (06 §8): ownership for writable cards, a reason for a higher tier. */
export function cardProblem(org: Organization, card: TaskCard): string | undefined {
    if (card.workspace !== 'readonly' && card.ownership.length === 0) {
        return `task ${card.id} changes files (workspace ${card.workspace}) but has no ownership; set the globs of the files it may change`;
    }
    if (card.assignee && findAgent(org, card.assignee)?.role === 'supervisor') {
        return `task ${card.id} is assigned to the supervisor; assign a member instead`;
    }
    const decision = resolveTier(roleFor(org, card), card, org);
    if (decision.rejected) {
        return `task ${card.id} asks for tier ${decision.rejected.tier}: ${decision.rejected.reason}`;
    }
    return undefined;
}

/**
 * Loads the organization for a project (06 §2): the built-in one, then the user level `<data>/orgs/default/`
 * (`org.md` and `agents/*.md`), then the project level `.xora/org.md` and `.xora/agents/*.md`. Project files can
 * change tool whitelists and permission modes, so they only count once the project is trusted (09 §5).
 */
export async function loadTeamOrganization(options: {
    readonly orgsDir: string;
    readonly projectDir: string;
    readonly trusted: boolean;
}): Promise<LoadedOrganization> {
    const loaded = await loadOrganization({
        userDir: path.join(options.orgsDir, 'default'),
        ...(options.trusted ? { projectDir: options.projectDir } : {}),
    });
    const projectFiles =
        existsSync(path.join(options.projectDir, '.xora', 'org.md')) ||
        existsSync(path.join(options.projectDir, '.xora', 'agents'));
    if (!options.trusted && projectFiles) {
        return {
            ...loaded,
            warnings: [...loaded.warnings, '项目还没有被信任，没有用项目里的组织定义（.xora/org.md、.xora/agents）'],
        };
    }
    return loaded;
}

// ---------------------------------------------------------------------------------------------------------
// Messages

function boardSummary(board: TaskBoard): string {
    const counts = new Map<string, number>();
    for (const task of board.list()) {
        counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    return [...counts].map(([status, count]) => `${count} ${status.replace('_', ' ')}`).join(', ') || 'no tasks';
}

/** The supervisor's first message: the goal (06 §4 layer 6) and how the host runs the team. */
export function supervisorBrief(goal: string, run: TeamRun, maxParallel: number): string {
    const approval = needsHuman(run.autonomy, 'plan_approval');
    return [
        renderTeamGoal({
            text: goal,
            autonomy: run.autonomy,
            ...(run.budget ? { budget: { limit: run.budget.limit, currency: run.budget.currency } } : {}),
        }),
        '',
        '<team_host>',
        '- Create the task cards with task_create; one call may hold several cards that depend on each other. Invalid cards come back with the reason: fix them and call again.',
        '- Writable cards (workspace worktree or local) need ownership globs. A worktree card runs in its own git worktree that starts from the results of the cards it depends on; a readonly card runs in the project folder without write access.',
        approval
            ? '- When the plan is complete, end your turn: the user approves it before anything is dispatched.'
            : '- When the plan is complete, end your turn: dispatch starts right away.',
        `- The host dispatches ready cards (at most ${maxParallel} at a time), runs their acceptance checks, sends failed deliveries back, escalates tiers, integrates the worktrees in dependency order and writes the delivery report. You get a <team_update> after task events.`,
        '- Members ask you questions through ask_supervisor; answer with send_message.',
        '</team_host>',
    ].join('\n');
}

/** Task events batched into one supervisor turn. */
export function wakeText(lines: readonly string[], board: TaskBoard): string {
    return [
        '<team_update>',
        ...lines.map((line) => `- ${line}`),
        `Board: ${boardSummary(board)}.`,
        '</team_update>',
        'Act only where needed (task_create, task_update, task_assign, send_message, ledger_update); otherwise end your turn with one short line.',
    ].join('\n');
}

/** Follows the task card in an executor's first message; `turns` is the card's turn budget. */
export function executorNote(card: TaskCard, location: 'worktree' | 'local', turns: number): string {
    const where =
        card.workspace === 'readonly'
            ? 'This card is read-only: change no files.'
            : location === 'worktree'
              ? 'You work in your own git worktree, which already holds the results of the cards this one depends on. Leave your changes uncommitted: the host integrates them.'
              : 'You work directly in the project folder. Do not commit.';
    return [
        '<team_host>',
        where,
        'When the work is done, call deliver with the deliverable and end your turn. If the card needs a stronger tier, call escalate with your findings. Use ask_supervisor only for what the card and the code cannot answer.',
        `You have ${turns} model turns for this card, rework after a failed acceptance included. When they run out the attempt fails and the card goes to a stronger tier, so deliver or escalate in time.`,
        '</team_host>',
    ].join('\n');
}

export const RESUME_PROMPT =
    'The app restarted while you were working on this card. Your workspace still has your changes: check where you stopped, finish the card and deliver.';

/** What a reviewer gets: the card, the deliverable, the host's command results and the changed files. */
export function reviewPrompt(
    card: TaskCard,
    deliverable: Deliverable,
    commands: readonly CommandResult[],
    changed: readonly string[],
    focus?: string,
): string {
    return [
        renderTaskCard(card),
        '',
        '<deliverable>',
        JSON.stringify(deliverable, null, 2),
        '</deliverable>',
        '',
        '<host_checks>',
        ...(commands.length > 0
            ? commands.map(
                  (result) =>
                      `- \`${result.run}\`: ${result.exit === null ? 'killed or timed out' : `exit ${result.exit}`}`,
              )
            : ['- no acceptance command was run']),
        '</host_checks>',
        '',
        '<changed_files>',
        ...(changed.length > 0 ? changed.map((file) => `- ${file}`) : ['- none']),
        '</changed_files>',
        '',
        `Review the deliverable of task ${card.id}. Your working directory is the executor's workspace: read the changed files there.${focus ? ` Focus: ${focus}.` : ''} Finish with the verdict JSON.`,
    ].join('\n');
}

/** A card's acceptance checks in one line, for the plan approval card. */
export function describeChecks(card: TaskCard): string {
    return card.acceptance
        .map((check) =>
            check.type === 'command'
                ? `\`${check.run}\`${check.expect === 'fail' ? '（应失败）' : ''}`
                : check.type === 'review'
                  ? `审查：${check.by}`
                  : `人工：${check.note}`,
        )
        .join('；');
}
