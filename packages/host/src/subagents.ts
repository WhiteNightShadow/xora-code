import { type AgentDefinition, effectiveTrust } from '@xora/extensions';
import {
    bilingual,
    type Effort,
    type ItemOf,
    type ModelRef,
    type Money,
    type PermissionMode,
    type Project,
    type ThreadMeta,
} from '@xora/protocol';
import { type AgentSpec, modelChain, type Organization, TIERS, type Tier } from '@xora/workflows';
import { connectedModels, effortOf, pickTierModel } from './agent-models.ts';
import type { ConnectionService } from './connections.ts';
import type { HostToolResult } from './engines/manager.ts';
import { XORA_ENGINE } from './engines/registry.ts';
import type { SessionExtras } from './extensions.ts';
import { newId } from './ids.ts';
import type { Logger } from './log.ts';
import { type MemberService, memberName } from './members.ts';
import type { ProjectService } from './projects.ts';
import type { SettingsService } from './settings.ts';
import { builtinsOutside, loadTeamOrganization, mcpPatternsOf, shorten } from './team-agents.ts';
import { textOf } from './text.ts';
import type { ThreadStore } from './threads.ts';
import type { HostToolProvider, SharedToolCall, SharedTools, TurnEnded, TurnService } from './turns.ts';

/**
 * Subagents (03 §4, 05, 06 §2): a thread's agent hands a self-contained task to a helper with the `agent` tool.
 * The helper is a child thread (`parent` set) in the same project folder, read-only unless the call lets it
 * write; it runs one turn on the task, and its last message comes back as the tool result while the parent's
 * turn shows a subagent card. A few run at once per turn, and there is no nesting: child threads and the members
 * of team and workflow runs do not get the tool. `@name` of a defined agent or of a member of the team (06 §19) in
 * a user's message asks the thread's agent to hand the message to it; a member's subagent works as that member.
 */

export const AGENT_TOOL = 'agent';
/** Subagents one turn runs at once; further calls wait for a free slot. */
export const MAX_PARALLEL_SUBAGENTS = 4;
/** How long one subagent may run before it is stopped. */
export const SUBAGENT_TIME_LIMIT_MS = 20 * 60_000;
/** The part of a subagent's answer the parent agent gets back; the rest stays in the child thread. */
export const MAX_ANSWER_CHARS = 20_000;
/** Defined agents described in the tool at most, and the length of each description there. */
const MAX_LISTED_AGENTS = 40;
const MAX_DESCRIPTION_CHARS = 300;
/** Changed files listed in a result at most. */
const MAX_LISTED_FILES = 100;
/** How long a subagent stopped for its time limit gets to wind down before the result is reported anyway. */
const STOP_GRACE_MS = 10_000;

const TEXT = bilingual(
    {
        tool: (parallel: number, minutes: number) =>
            [
                '把一项独立的任务交给子agent：它在自己的线程里、用自己的上下文工作，和你在同一个项目文件夹里，做完后把最终回答作为这个工具的结果交回给你。',
                '适合用在：',
                `- 可以并行的独立调研或探索：在一次回复里多次调用，最多同时运行${parallel}个；`,
                '- 让你自己的上下文保持精简：由子agent去读文件、跑命令，你只拿结论；',
                '- 交给下面某个已定义agent的一块独立工作。',
                '子agent看不到这段对话，只看得到`prompt`：把它需要的事实、路径和要求都写进去，并说明回答里要有什么。',
                `子agent默认只读；\`write\`为true时它可以改文件，权限模式和你相同，几个并行的写任务要分开改不同的文件。每个子agent最多运行${minutes}分钟，不能再启动子agent。`,
            ].join('\n'),
        agents: (list: string) => `已定义的agent（把名字填进\`agent\`）：\n${list}`,
        agentLine: (name: string, description: string) => `- ${name}：${description}`,
        memberLine: (name: string, id: string, description: string) =>
            `- ${name}（团队成员${id}）${description ? `：${description}` : ''}`,
        noAgents: '这个项目没有定义agent：不填`agent`，就是一个通用子agent。',
        description: '用几个词概括这项任务，作为子agent线程的标题',
        prompt: '完整、自成一体的任务说明：子agent只看得到这段文字',
        agent: '已定义agent的名字；不填就是通用子agent',
        write: '为true时子agent可以改文件；默认false，只读',
        names: (names: readonly string[]) => names.join('、'),
        handoff: (names: string) =>
            `<agent_handoff>\n用户在这条消息里点名了${names}：用agent工具把这次的请求交给点名的agent（\`agent\`填它的名字，点名了几个就各调用一次），\`prompt\`里写清完整的任务：用户的要求和它需要的上下文。结果回来后，把结果告诉用户。\n</agent_handoff>`,
        briefTitle: '子agent',
        brief: '你是另一个agent启动的子agent。第一条消息就是你的任务，也是你能得到的全部信息：直接去做，不要提问（没有人会回答），也不要把任务再交出去。你的最后一条消息会原样交回给那个agent，所以要写成完整、能独立看懂的回答：结论加上依据（文件路径、行号、命令输出）。',
        noAnswer: '子agent结束了，但没有给出最终回答。',
        cut: (threadId: string) => `…（回答太长，后面截掉了；全文在线程${threadId}里）`,
        changed: (files: string) => `子agent改动的文件：${files}`,
        unchanged: '子agent没有改动文件。',
        failed: (message: string) => `子agent失败了：${message}`,
        stopped: '子agent在完成之前被停止了。',
        timedOut: (minutes: number) => `子agent在${minutes}分钟内没有完成，已经停止。`,
        turnStopped: '这一轮已停止，子agent也随之停止。',
        notStarted: (message: string) => `子agent没能启动：${message}`,
        lastWords: (text: string) => `它停止前的最后一条消息：\n${text}`,
        missing: (field: string) => `缺少\`${field}\``,
        notText: (field: string) => `\`${field}\`要是字符串`,
        notBoolean: (field: string) => `\`${field}\`要是true或false`,
        badInput: (problem: string) => `参数不对：${problem}`,
        unknownAgent: (name: string, names: string) => `没有名为${name}的agent。已定义的agent：${names}`,
        none: '无',
        unavailable: (name: string) => `这里没有工具${name}`,
        unknownFailure: '原因不明',
        noAnswerSummary: '没有最终回答',
        stoppedSummary: '已停止',
        timedOutSummary: (minutes: number) => `${minutes}分钟内没有完成，已停止`,
    },
    {
        tool: (parallel, minutes) =>
            [
                "Hands a self-contained task to a subagent: a helper that works in its own thread with its own context, in the same project folder as you, and returns its final answer as this tool's result.",
                'Use it for:',
                `- independent research or exploration that can run in parallel: call it several times in one response; up to ${parallel} run at once;`,
                '- keeping your own context small: the subagent reads the files and runs the commands, you get the conclusion;',
                '- a separate piece of work for one of the defined agents below.',
                'The subagent sees nothing of this conversation except `prompt`: put in every fact, path and requirement it needs, and say what its answer should contain.',
                `A subagent is read-only unless \`write\` is true; then it may change files, in the same permission mode as you, and subagents writing in parallel must change different files. Each subagent runs for at most ${minutes} minutes and cannot start subagents of its own.`,
            ].join('\n'),
        agents: (list) => `Defined agents (pass the name as \`agent\`):\n${list}`,
        agentLine: (name, description) => `- ${name}: ${description}`,
        memberLine: (name, id, description) => `- ${name} (team member ${id})${description ? `: ${description}` : ''}`,
        noAgents: 'No agents are defined in this project: leave out `agent` for a general-purpose subagent.',
        description: "A few words naming the task; the title of the subagent's thread",
        prompt: 'The full, self-contained task: the only thing the subagent sees',
        agent: 'Name of a defined agent; leave it out for a general-purpose subagent',
        write: 'true lets the subagent change files; false (the default) keeps it read-only',
        names: (names) => names.join(', '),
        handoff: (names) =>
            `<agent_handoff>\nThe user addressed ${names} in this message: hand the request to the agent they named with the agent tool (its name as \`agent\`; one call for each agent named), with a self-contained \`prompt\` that holds the user's request and the context it needs. When the result comes back, report it to the user.\n</agent_handoff>`,
        briefTitle: 'Subagent',
        brief: 'You are a subagent another agent started. The first message is your task and all you get: do it without asking questions (nobody will answer) and without handing it on. Your last message goes back to that agent as it is, so make it a complete answer that stands on its own: the conclusion with its evidence (file paths, line numbers, command output).',
        noAnswer: 'The subagent ended without a final answer.',
        cut: (threadId) => `… (the answer was too long and was cut here; all of it is in thread ${threadId})`,
        changed: (files) => `Files the subagent changed: ${files}`,
        unchanged: 'The subagent changed no files.',
        failed: (message) => `The subagent failed: ${message}`,
        stopped: 'The subagent was stopped before it finished.',
        timedOut: (minutes) => `The subagent did not finish within ${minutes} minutes and was stopped.`,
        turnStopped: 'This turn was stopped, and the subagent with it.',
        notStarted: (message) => `The subagent could not start: ${message}`,
        lastWords: (text) => `Its last message before it stopped:\n${text}`,
        missing: (field) => `\`${field}\` is required`,
        notText: (field) => `\`${field}\` must be a string`,
        notBoolean: (field) => `\`${field}\` must be true or false`,
        badInput: (problem) => `Invalid arguments: ${problem}`,
        unknownAgent: (name, names) => `There is no agent named ${name}. Defined agents: ${names}`,
        none: 'none',
        unavailable: (name) => `Tool ${name} is not available here`,
        unknownFailure: 'reason unknown',
        noAnswerSummary: 'No final answer',
        stoppedSummary: 'Stopped',
        timedOutSummary: (minutes) => `Did not finish within ${minutes} minutes; stopped`,
    },
);

/** Claude Code's tool names in agent files, as the xora engine calls its tools; other names are lower-cased. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
    ls: 'list',
    multiedit: 'multi_edit',
    notebookedit: 'edit',
    todowrite: 'todo',
    todoread: 'todo',
    webfetch: 'web_fetch',
    websearch: 'web_search',
};

/** Permission modes from the most to the least restrictive (10 §2). */
const MODES: readonly PermissionMode[] = ['plan', 'ask', 'auto_edit', 'full'];

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function addMoney(total: Money | null, add: Money): Money {
    return total ? { amount: Math.round((total.amount + add.amount) * 1e6) / 1e6, currency: total.currency } : add;
}

/** Threads that get the `agent` tool: xora threads that are neither subagents nor members of a team or workflow run. */
export function canDelegate(thread: ThreadMeta): boolean {
    return thread.engine === XORA_ENGINE.id && !thread.parent && !thread.teamRunId && !thread.workflowRunId;
}

/** A subagent is read-only unless the call lets it write; then it has the parent's mode, or its agent's if stricter. */
export function subagentMode(parent: PermissionMode, write: boolean, agentMode?: string): PermissionMode {
    if (!write) {
        return 'plan';
    }
    // Agent files write `auto-edit`; an untrusted project's file can only make it stricter (09 §5).
    const own = MODES.find((mode) => mode === agentMode?.trim().toLowerCase().replace('-', '_'));
    return own !== undefined && MODES.indexOf(own) < MODES.indexOf(parent) ? own : parent;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The defined agents a message addresses as `@name`, in any case. Longer names are tried first and taken out, so
 * `@code-reviewer` is not `@code` too; `@reviewer.md` (a file) and `me@reviewer` are not mentions.
 */
export function mentionedAgents(text: string, names: readonly string[]): string[] {
    const found: string[] = [];
    let rest = text;
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
        const mention = new RegExp(`(^|[^A-Za-z0-9_@])@${escapeRegExp(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`, 'gi');
        const next = rest.replace(mention, '$1');
        if (next !== rest) {
            found.push(name);
            rest = next;
        }
    }
    return found;
}

/** The agent definitions a turn may use: plugins' only when enabled with their permissions confirmed. */
function usableAgents(extras: SessionExtras | undefined): AgentDefinition[] {
    return (extras?.loaded.agents ?? []).filter((agent) => effectiveTrust(agent.origin, agent.trusted).useAgents);
}

function findAgent(agents: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
    const lower = name.toLowerCase();
    return agents.find((agent) => agent.name === name) ?? agents.find((agent) => agent.name.toLowerCase() === lower);
}

/** Tool names of an agent file (`Read`, `Bash(git:*)`, `mcp__github`) as the engine's tools. */
function engineToolNames(tools: readonly string[]): string[] {
    return tools.map((tool) => {
        const name = tool.replace(/\(.*$/s, '').trim();
        if (name.startsWith('mcp__')) {
            return name;
        }
        const lower = name.toLowerCase();
        return CLAUDE_TOOL_NAMES[lower] ?? lower;
    });
}

function agentTool(
    agents: readonly AgentDefinition[],
    members: readonly AgentSpec[],
    minutes: number,
): HostToolProvider['tools'][number] {
    const text = textOf(TEXT);
    const listed = [
        ...agents.map((agent) => text.agentLine(agent.name, shorten(agent.description, MAX_DESCRIPTION_CHARS))),
        ...members.map((member) =>
            text.memberLine(memberName(member), member.id, shorten(member.description ?? '', MAX_DESCRIPTION_CHARS)),
        ),
    ].slice(0, MAX_LISTED_AGENTS);
    const names = [...agents.map((agent) => agent.name), ...members.map((member) => memberName(member))];
    return {
        name: AGENT_TOOL,
        description: [
            text.tool(MAX_PARALLEL_SUBAGENTS, minutes),
            listed.length > 0 ? text.agents(listed.join('\n')) : text.noAgents,
        ].join('\n\n'),
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string', description: text.description },
                prompt: { type: 'string', description: text.prompt },
                ...(names.length > 0 ? { agent: { type: 'string', enum: names, description: text.agent } } : {}),
                write: { type: 'boolean', description: text.write },
            },
            required: ['description', 'prompt'],
            additionalProperties: false,
        },
        kind: 'other',
    };
}

/**
 * The child's tools: its agent's whitelist, enforced by the host (06 §4), and while it works for its parent the
 * brief on how it reports. Someone who goes on talking to it later is not its parent.
 */
function childTools(agent: AgentDefinition | undefined, brief: boolean): HostToolProvider {
    const text = textOf(TEXT);
    const allowed = agent?.tools ? engineToolNames(agent.tools) : undefined;
    const disabled = [
        ...new Set([...(allowed ? builtinsOutside(allowed) : []), ...engineToolNames(agent?.disallowedTools ?? [])]),
    ];
    return {
        tools: [],
        layers: brief ? [{ id: 'subagent_instructions', title: text.briefTitle, text: text.brief }] : [],
        ...(disabled.length > 0 ? { disabledTools: disabled } : {}),
        ...(allowed ? { mcpTools: mcpPatternsOf(allowed) } : {}),
        handle: async (name) => ({ content: text.unavailable(name), isError: true }),
    };
}

interface AgentCall {
    readonly description: string;
    readonly prompt: string;
    readonly agent?: string;
    readonly write: boolean;
}

/** Who a subagent works as: a defined agent (or none, general purpose), or a member of the team. */
type Helper =
    | { readonly kind: 'agent'; readonly agent: AgentDefinition | undefined }
    | { readonly kind: 'member'; readonly member: AgentSpec; readonly org: Organization };

/** Members a thread may hand work to: everyone but the supervisor, which only works in team runs; agents win a clash. */
function delegableMembers(members: readonly AgentSpec[], agents: readonly AgentDefinition[]): AgentSpec[] {
    const taken = new Set(agents.map((agent) => agent.name.toLowerCase()));
    return members.filter(
        (member) =>
            member.role !== 'supervisor' &&
            !taken.has(member.id.toLowerCase()) &&
            !taken.has(memberName(member).toLowerCase()),
    );
}

function findMember(members: readonly AgentSpec[], name: string): AgentSpec | undefined {
    const lower = name.toLowerCase();
    return (
        members.find((member) => memberName(member).toLowerCase() === lower) ??
        members.find((member) => member.id.toLowerCase() === lower)
    );
}

/** The call's arguments, or what is wrong with them. */
function readCall(input: unknown): AgentCall | string {
    const text = textOf(TEXT);
    const args = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    for (const field of ['description', 'prompt'] as const) {
        if (typeof args[field] !== 'string' || !args[field].trim()) {
            return text.missing(field);
        }
    }
    if (args.agent !== undefined && args.agent !== null && typeof args.agent !== 'string') {
        return text.notText('agent');
    }
    // Models now and then send the boolean as text.
    const write = args.write === 'true' ? true : args.write === 'false' ? false : args.write;
    if (write !== undefined && write !== null && typeof write !== 'boolean') {
        return text.notBoolean('write');
    }
    const agent = typeof args.agent === 'string' ? args.agent.trim() : '';
    return {
        description: String(args.description).trim(),
        prompt: String(args.prompt).trim(),
        ...(agent ? { agent } : {}),
        write: write === true,
    };
}

/** The subagents of one parent turn: at most {@link MAX_PARALLEL_SUBAGENTS} at once, the others wait in order. */
class TurnSlots {
    /** Stops them all, when the parent's turn ends under them. */
    readonly abort = new AbortController();
    /** Calls running or waiting. */
    calls = 0;
    #active = 0;
    readonly #queue: Array<() => void> = [];

    /** Resolves true with a slot, or false when `signal` aborts first. */
    acquire(signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) {
            return Promise.resolve(false);
        }
        if (this.#active < MAX_PARALLEL_SUBAGENTS) {
            this.#active++;
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const grant = () => {
                signal.removeEventListener('abort', stop);
                this.#active++;
                resolve(true);
            };
            const stop = () => {
                const index = this.#queue.indexOf(grant);
                if (index >= 0) this.#queue.splice(index, 1);
                resolve(false);
            };
            this.#queue.push(grant);
            signal.addEventListener('abort', stop, { once: true });
        });
    }

    release(): void {
        this.#active--;
        this.#queue.shift()?.();
    }
}

type Outcome = TurnEnded | 'aborted' | 'timeout';

export interface SubagentDeps {
    readonly threads: ThreadStore;
    readonly projects: ProjectService;
    readonly turns: TurnService;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly log: Logger;
    /** Team organizations, whose model tiers a defined agent's `tier` picks from (06 §3). */
    readonly orgsDir: string;
    /** How long one subagent may run; {@link SUBAGENT_TIME_LIMIT_MS} by default. */
    readonly timeLimitMs?: number;
    /** The team's members a thread may hand work to by name or `@` mention (06 §19). */
    readonly members?: Pick<MemberService, 'roster' | 'provider'>;
}

export class SubagentService implements SharedTools {
    readonly names = [AGENT_TOOL];
    readonly #deps: SubagentDeps;
    /** Resolves when a subagent's turn ends, by its thread. */
    readonly #waiters = new Map<string, (event: TurnEnded) => void>();
    /** Parent turns with subagents running or waiting, by turn. */
    readonly #turns = new Map<string, TurnSlots>();

    constructor(deps: SubagentDeps) {
        this.#deps = deps;
    }

    get #minutes(): number {
        return Math.max(1, Math.round((this.#deps.timeLimitMs ?? SUBAGENT_TIME_LIMIT_MS) / 60_000));
    }

    async tools(thread: ThreadMeta, extras: SessionExtras | undefined): Promise<HostToolProvider['tools']> {
        if (!canDelegate(thread)) {
            return [];
        }
        const agents = usableAgents(extras);
        const team = await this.#team(thread.projectId);
        return [agentTool(agents, delegableMembers(team?.members ?? [], agents), this.#minutes)];
    }

    /** The hand-off of a message that mentions defined agents or members (03 §4 "@agent下发", 06 §19). */
    async instructions(
        thread: ThreadMeta,
        extras: SessionExtras | undefined,
        text: string,
    ): Promise<string | undefined> {
        if (!canDelegate(thread) || !text.includes('@')) {
            return undefined;
        }
        const agents = usableAgents(extras);
        const members = delegableMembers((await this.#team(thread.projectId))?.members ?? [], agents);
        // A member is addressed by its name or its id, and handed the work by its name.
        const byMention = new Map<string, string>();
        for (const agent of agents) byMention.set(agent.name, agent.name);
        for (const member of members) {
            const name = memberName(member);
            if (!byMention.has(name)) byMention.set(name, name);
            if (!byMention.has(member.id)) byMention.set(member.id, name);
        }
        const named = [
            ...new Set(
                mentionedAgents(text, [...byMention.keys()]).map((mention) => byMention.get(mention) ?? mention),
            ),
        ];
        const words = textOf(TEXT);
        return named.length > 0 ? words.handoff(words.names(named.map((name) => `@${name}`))) : undefined;
    }

    /** The project's members with their organization; none when the project cannot be read. */
    async #team(projectId: string): Promise<{ org: Organization; members: AgentSpec[] } | undefined> {
        if (!this.#deps.members) {
            return undefined;
        }
        try {
            const { org, members } = await this.#deps.members.roster(projectId);
            return { org, members };
        } catch (error) {
            this.#deps.log.warn(`subagent members of ${projectId}: ${errorText(error)}`);
            return undefined;
        }
    }

    async handle(name: string, input: unknown, call: SharedToolCall): Promise<HostToolResult> {
        const text = textOf(TEXT);
        if (name !== AGENT_TOOL) {
            return { content: text.unavailable(name), isError: true };
        }
        const args = readCall(input);
        if (typeof args === 'string') {
            return { content: text.badInput(args), isError: true };
        }
        const parent = this.#deps.threads.find(call.threadId);
        if (!parent) {
            return { content: text.turnStopped, isError: true };
        }
        const agents = usableAgents(call.extras);
        const agent = args.agent ? findAgent(agents, args.agent) : undefined;
        let helper: Helper = { kind: 'agent', agent };
        if (args.agent && !agent) {
            const team = await this.#team(parent.projectId);
            const members = delegableMembers(team?.members ?? [], agents);
            const member = findMember(members, args.agent);
            if (!team || !member) {
                const names =
                    [...agents.map((item) => item.name), ...members.map((item) => memberName(item))].join(', ') ||
                    text.none;
                return { content: text.unknownAgent(args.agent, names), isError: true };
            }
            helper = { kind: 'member', member, org: team.org };
        }
        let slots = this.#turns.get(call.turnId);
        if (!slots) {
            slots = new TurnSlots();
            this.#turns.set(call.turnId, slots);
        }
        slots.calls++;
        const signal = AbortSignal.any([call.signal, slots.abort.signal]);
        try {
            if (!(await slots.acquire(signal))) {
                return { content: text.turnStopped, isError: true };
            }
            try {
                return await this.#run(parent, helper, args, call, signal);
            } finally {
                slots.release();
            }
        } catch (error) {
            this.#deps.log.warn(`subagent of ${call.threadId}: ${errorText(error)}`);
            return { content: text.notStarted(errorText(error)), isError: true };
        } finally {
            slots.calls--;
            if (slots.calls === 0 && this.#turns.get(call.turnId) === slots) {
                this.#turns.delete(call.turnId);
            }
        }
    }

    /** Turn hook: a subagent's turn ended, or a parent's turn ended with subagents still under it. */
    onTurnEnded(event: TurnEnded): void {
        const waiter = this.#waiters.get(event.threadId);
        if (waiter) {
            this.#waiters.delete(event.threadId);
            this.#addCost(event.threadId);
            waiter(event);
        }
        // Its engine may have died under them: nobody waits for their answers anymore.
        this.#turns.get(event.turnId)?.abort.abort();
    }

    dispose(): void {
        for (const slots of this.#turns.values()) {
            slots.abort.abort();
        }
    }

    async #run(
        parent: ThreadMeta,
        helper: Helper,
        args: AgentCall,
        call: SharedToolCall,
        signal: AbortSignal,
    ): Promise<HostToolResult> {
        const { threads, projects, turns } = this.#deps;
        const text = textOf(TEXT);
        const project = await projects.get(parent.projectId);
        const agent = helper.kind === 'agent' ? helper.agent : undefined;
        const member = helper.kind === 'member' ? helper.member : undefined;
        const model =
            helper.kind === 'member'
                ? this.#memberModel(parent, project, helper)
                : await this.#modelFor(parent, project, agent);
        if (signal.aborted) {
            return { content: text.turnStopped, isError: true };
        }
        const child = threads.create({
            projectId: parent.projectId,
            title: shorten(args.description, 60),
            engine: XORA_ENGINE.id,
            model: model.ref,
            mode: subagentMode(parent.mode, args.write, member?.mode ?? agent?.mode),
            effort: model.effort,
            // The same folder, a worktree included: the subagent works on what its parent sees.
            location: parent.location,
            ...(agent?.prompt ? { sessionPrompt: agent.prompt } : {}),
            extra: {
                parent: { threadId: parent.id, turnId: call.turnId },
                ...(agent ? { agentId: agent.name } : {}),
                ...(member ? { agentId: member.id, role: member.role } : {}),
                ...(model.tier ? { tier: model.tier } : {}),
            },
        });
        turns.setHostTools(child.id, this.#helperTools(helper, parent.projectId, true));
        const ended = new Promise<TurnEnded>((resolve) => this.#waiters.set(child.id, resolve));
        try {
            await turns.start(child.id, args.prompt);
        } catch (error) {
            this.#waiters.delete(child.id);
            turns.setHostTools(child.id, undefined);
            threads.delete(child.id);
            return { content: text.notStarted(errorText(error)), isError: true };
        }
        const who = member ? memberName(member) : (agent?.name ?? '');
        this.#deps.log.info(`subagent ${child.id} of ${parent.id}${who ? ` (${who})` : ''}`);
        const item: ItemOf<'subagent'> = {
            id: newId('i'),
            turnId: call.turnId,
            ts: Date.now(),
            type: 'subagent',
            taskId: call.toolCallId ?? child.id,
            title: child.title,
            agent: who,
            status: 'running',
            threadId: child.id,
            ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
        };
        turns.showItem(parent.id, item, false);
        const finish = (status: ItemOf<'subagent'>['status'], summary: string, cost?: Money | null) =>
            turns.showItem(
                parent.id,
                { ...item, status, summary: shorten(summary, 200), ...(cost ? { cost } : {}) },
                true,
            );
        const limitMs = this.#deps.timeLimitMs ?? SUBAGENT_TIME_LIMIT_MS;
        const outcome = await this.#outcome(ended, signal, limitMs);
        turns.setHostTools(child.id, this.#helperTools(helper, parent.projectId, false));
        if (outcome === 'aborted') {
            // First, while the parent's turn still runs: its card ends with it.
            finish('cancelled', text.stoppedSummary);
            turns.cancel(child.id);
            return { content: text.turnStopped, isError: true };
        }
        if (outcome === 'timeout') {
            turns.cancel(child.id);
            const stopped = await this.#outcome(ended, signal, STOP_GRACE_MS);
            finish('failed', text.timedOutSummary(this.#minutes), this.#costOf(child.id));
            const last = typeof stopped === 'object' ? stopped.lastText.trim() : '';
            return {
                content: [text.timedOut(this.#minutes), ...this.#lastWords(last, child.id)].join('\n\n'),
                isError: true,
            };
        }
        const cost = this.#costOf(child.id);
        const answer = outcome.lastText.trim();
        if (outcome.outcome === 'failed') {
            const message = this.#failure(child.id) ?? text.unknownFailure;
            finish('failed', message, cost);
            return {
                content: [text.failed(message), ...this.#lastWords(answer, child.id)].join('\n\n'),
                isError: true,
            };
        }
        if (outcome.outcome === 'cancelled') {
            finish('cancelled', text.stoppedSummary, cost);
            return { content: [text.stopped, ...this.#lastWords(answer, child.id)].join('\n\n'), isError: true };
        }
        finish('completed', answer || text.noAnswerSummary, cost);
        const reply = answer ? this.#capped(answer, child.id) : text.noAnswer;
        if (!args.write) {
            return { content: reply };
        }
        const files = outcome.changedFiles;
        const listed = files.length > MAX_LISTED_FILES ? [...files.slice(0, MAX_LISTED_FILES), '…'] : files;
        return { content: `${reply}\n\n${listed.length > 0 ? text.changed(listed.join(', ')) : text.unchanged}` };
    }

    /**
     * The child's tools: a defined agent's whitelist, or a member's own setup (its layers, whitelist, memory and
     * `remember`); while it works for its parent, the brief on how it reports.
     */
    #helperTools(helper: Helper, projectId: string, brief: boolean): HostToolProvider {
        if (helper.kind === 'agent' || !this.#deps.members) {
            return childTools(helper.kind === 'agent' ? helper.agent : undefined, brief);
        }
        const text = textOf(TEXT);
        return this.#deps.members.provider(helper.member, helper.org, projectId, {
            layers: brief ? [{ id: 'subagent_instructions', title: text.briefTitle, text: text.brief }] : [],
        });
    }

    /** A member's subagent works on its tier's model (06 §3), or on its parent's when the tier has none. */
    #memberModel(
        parent: ThreadMeta,
        project: Project,
        helper: Extract<Helper, { kind: 'member' }>,
    ): { ref: ModelRef | null; effort: Effort; tier?: Tier } {
        const { member, org } = helper;
        try {
            const pick = pickTierModel(this.#deps, {
                org,
                project,
                tier: member.tier,
                unattended: false,
                warnings: [],
                ...(member.models ? { prefer: member.models } : {}),
            });
            return { ref: pick.ref, effort: pick.effort, tier: member.tier };
        } catch (error) {
            this.#deps.log.warn(`subagent ${member.id}: tier ${member.tier}: ${errorText(error)}`);
            return {
                ref: parent.model ?? project.defaults?.model ?? this.#deps.settings.get().defaultModel,
                effort: parent.effort,
            };
        }
    }

    /** The subagent's turn ending, the parent's stop, or the time running out, whichever comes first. */
    #outcome(ended: Promise<TurnEnded>, signal: AbortSignal, timeoutMs: number): Promise<Outcome> {
        return new Promise((resolve) => {
            if (signal.aborted) {
                resolve('aborted');
                return;
            }
            const done = (outcome: Outcome) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve(outcome);
            };
            const onAbort = () => done('aborted');
            const timer = setTimeout(() => done('timeout'), timeoutMs);
            signal.addEventListener('abort', onAbort, { once: true });
            void ended.then(done);
        });
    }

    /**
     * The model of a subagent (06 §3): its agent's `model` when connected, else the first connected model of its
     * agent's `tier`, else the parent's model.
     */
    async #modelFor(
        parent: ThreadMeta,
        project: Project,
        agent: AgentDefinition | undefined,
    ): Promise<{ ref: ModelRef | null; effort: Effort; tier?: Tier }> {
        const { connections, settings, log } = this.#deps;
        const inherited = {
            ref: parent.model ?? project.defaults?.model ?? settings.get().defaultModel,
            effort: parent.effort,
        };
        if (!agent) {
            return inherited;
        }
        const available = connectedModels(connections);
        const wanted = agent.model?.trim().toLowerCase();
        if (wanted && wanted !== 'inherit') {
            const found = available.find((model) => model.model.toLowerCase() === wanted);
            if (found) {
                return { ref: { connectionId: found.connectionId, model: found.model }, effort: parent.effort };
            }
        }
        const tier = TIERS.find((name) => name === agent.tier?.trim().toLowerCase());
        if (tier) {
            try {
                const { org } = await loadTeamOrganization({
                    orgsDir: this.#deps.orgsDir,
                    projectDir: project.path,
                    trusted: project.trusted,
                });
                const head = modelChain(tier, org, available)[0];
                if (head) {
                    return {
                        ref: { connectionId: head.connectionId, model: head.model },
                        effort: effortOf(head.effort),
                        tier,
                    };
                }
            } catch (error) {
                log.warn(`subagent ${agent.name}: tier ${tier}: ${errorText(error)}`);
            }
        }
        return inherited;
    }

    #capped(answer: string, threadId: string): string {
        return answer.length > MAX_ANSWER_CHARS
            ? `${answer.slice(0, MAX_ANSWER_CHARS)}\n${textOf(TEXT).cut(threadId)}`
            : answer;
    }

    #lastWords(text: string, threadId: string): string[] {
        return text ? [textOf(TEXT).lastWords(this.#capped(text, threadId))] : [];
    }

    #costOf(threadId: string): Money | null {
        return this.#deps.threads.find(threadId)?.cost ?? null;
    }

    /** The parent thread's cost includes its subagents' (11: thread, subagents included). */
    #addCost(childId: string): void {
        const { threads } = this.#deps;
        const child = threads.find(childId);
        const parent = child?.parent ? threads.find(child.parent.threadId) : undefined;
        if (child?.cost && child.cost.amount > 0 && parent) {
            threads.update(parent.id, { cost: addMoney(parent.cost, child.cost) }, { touch: false });
        }
    }

    /** Why the subagent's last turn failed, as its error card says. */
    #failure(threadId: string): string | undefined {
        const events = this.#deps.threads.events(threadId);
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (event?.kind === 'turn.failed') {
                return (event.payload as { error?: { message?: string } }).error?.message;
            }
        }
        return undefined;
    }
}
