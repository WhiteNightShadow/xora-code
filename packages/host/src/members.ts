import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    bilingual,
    type HostMethods,
    type HostNotifications,
    type Member,
    type MemberRoutine,
    type PermissionMode,
    type Project,
    RpcError,
    RpcErrorCode,
    type RpcPeer,
    type ThreadMeta,
} from '@xora/protocol';
import {
    type AgentSpec,
    cronError,
    DEFAULT_ORG,
    isTimeZone,
    loadOrganization,
    nextCronTime,
    type Organization,
    parseCron,
    parseFrontmatter,
    ROLES,
    SUBSCRIPTION_CHANNEL,
    TIERS,
    tierLabel,
} from '@xora/workflows';
import { pickTierModel } from './agent-models.ts';
import type { Bus } from './bus.ts';
import type { ConnectionService } from './connections.ts';
import type { HostToolResult } from './engines/manager.ts';
import { newId } from './ids.ts';
import { type Logger, redact } from './log.ts';
import type { ProjectService } from './projects.ts';
import type { SettingsService } from './settings.ts';
import { disabledBuiltins, loadTeamOrganization, mcpToolsOf, shorten, systemLayers } from './team-agents.ts';
import { hostLanguage, textOf } from './text.ts';
import type { ThreadStore } from './threads.ts';
import type { TriggerTarget } from './triggers.ts';
import type { HostToolProvider, TurnService } from './turns.ts';

/**
 * Members of the team (06 §19): the organization's agents as the user sees and uses them. A member has a name, a
 * job, a model tier and permissions (its agent file, or the built-in definition), a long-term memory it keeps itself
 * with the `remember` tool, and routines it runs on a schedule. Its conversations, routine runs, workflow steps,
 * team tasks and the subagents started for it by an `@` mention are threads with its id as `agentId`.
 */

/** The part of a member's memory a prompt carries; the most recent notes are kept. */
export const MEMORY_PROMPT_CHARS = 8_000;
/** A memory file stays under this: a new note pushes out the oldest ones. */
export const MEMORY_FILE_CHARS = 16_000;
/** The longest note `remember` takes. */
export const NOTE_CHARS = 500;
export const REMEMBER_TOOL = 'remember';
/** Trigger keys of routines start with this; workflow triggers are keyed `projectId|key`. */
const ROUTINE_KEY = 'member:';
const DEFAULT_THREAD_LIMIT = 50;
/** The longest id a new member gets from its name. */
const ID_LENGTH = 40;

const TEXT = bilingual(
    {
        names: {
            supervisor: '主管',
            planner: '规划',
            'plan-reviewer': '计划评审',
            scout: '侦察',
            coder: '编码',
            tester: '测试',
            writer: '文档',
            debugger: '修bug',
            reviewer: '审查',
            specialist: '专家',
        } as Readonly<Record<string, string>>,
        badRole: (role: string, roles: string) => `角色${role}不对，只能是：${roles}`,
        badTier: (tier: string, tiers: string) => `档位${tier}不对，只能是：${tiers}`,
        noName: '先给成员起个名字',
        nameTaken: (name: string) => `已经有成员叫“${name}”了：换个名字`,
        needProject: '只用在一个项目里的成员，要先选项目',
        untrusted: (project: string) =>
            `项目${project}还没有被信任，项目里的成员定义（.xora/agents）要信任后才生效：先在设置的扩展页信任它`,
        projectMissing: (folder: string) => `项目文件夹不存在：${folder}`,
        projectGone: '项目已经不在了',
        notFound: (id: string) => `没有成员${id}`,
        notInProject: (name: string, project: string) =>
            `${name}不在项目${project}的成员里：只在别的项目里用的成员，不能在这里干活`,
        builtinStays: (name: string) => `${name}是内置成员，没法删除；改过的话可以恢复默认`,
        routineMissing: '没有这个例行任务',
        badSchedule: (error: string) => `时间写得不对：${error}`,
        badTimezone: (zone: string) => `不认识时区${zone}`,
        subscriptionOnly: (tier: string) =>
            `例行任务没人看着，只用按量计费的模型（api、本地或自定义）；${tier}档和默认模型都是订阅额度：在设置里给这个档位连一个按量计费的模型`,
        memoryTitle: (name: string) => `记忆：${name}`,
        memory: (name: string, project: string | undefined, notes: string) =>
            [
                `这是${name}的长期记忆：以前干活时你自己用remember记下的笔记，每条开头是记下它的项目和日期${project ? `（现在在项目“${project}”里）` : ''}。别的项目里记的不一定适用于这里；笔记和现在看到的事实对不上时以事实为准，并用remember改掉过时的那条。`,
                '',
                notes,
                '',
                '学到以后还用得上的事，就用remember记一条：项目里的事实（怎么构建和测试、目录和约定）、用户的偏好和要求、试过行得通或行不通的做法。每条一句话，单独看也能懂。不记密钥、token、密码，也不记只跟这一次有关的细节。',
            ].join('\n'),
        noNotes: '（还没有笔记）',
        olderOmitted: '（更早的笔记没有放进来）',
        contextTitle: '在这里怎么干活',
        context:
            '你现在不在团队运行里：这里没有任务卡、主管和交付物，也没有deliver、ask_supervisor这些团队工具。上面说明里讲任务卡、交付物JSON和向主管汇报的部分，在这里都不用管；其余的做事方法照旧。用平常的文字回答：先给结论，再给依据。',
        rememberTool:
            '把以后干活还用得上的事记进你的长期记忆，下次干活时会带上：项目里的事实（怎么构建和测试、目录和约定）、用户的偏好和要求、试过行得通或行不通的做法。每条一句话，单独看也能懂。不要记密钥、token、密码，也不要记只跟这一次有关的细节。记错或过时的，用replaces指出要换掉的那条。',
        rememberNote: '要记的一句话，最多500字',
        rememberReplaces: '要换掉的那条笔记里的一段原文；不填就是新加一条',
        noted: '记下了。',
        replaced: '换掉了原来那条。',
        already: '这条已经记过了。',
        dropped: (count: number) => `记忆超过${MEMORY_FILE_CHARS}字，删掉了最早的${count}条。`,
        noteMissing: '`note`要是一句不为空的话',
        noteTooLong: (length: number) => `这条有${length}字，超过${NOTE_CHARS}字：写短一点`,
        noteSecret: '这条看起来带着密钥、token或密码，没有记：这类东西不进记忆',
        noMatch: (part: string) => `没有哪条笔记里有“${part}”，什么都没改`,
        unavailable: (name: string) => `这里没有工具${name}`,
        chatTitle: (name: string, text: string) => `${name}：${text}`,
        routineTitle: (title: string) => `例行：${title}`,
        routinePrompt: (title: string, instruction: string) =>
            [
                `例行任务：${title}`,
                '',
                '这次运行没有人在看。能做的直接做完；做不了的（缺权限、缺信息、要人确认的操作）不要停下来等，跳过它，在汇报里写明原因。',
                '',
                '要做的事：',
                instruction,
                '',
                '最后按下面三节汇报，三个标题都要有：',
                '## 结论',
                '是什么情况，最重要的发现或产出（关键数字、文件路径）；没做成就直说。',
                '## 问题',
                '需要人知道或处理的事，每条一行，以“- ”开头；没有就写“- 无”。',
                '## 下一步',
                '建议做什么，按优先级排，每条一行，以“- ”开头。',
            ].join('\n'),
    },
    {
        names: Object.fromEntries(DEFAULT_ORG.roster.map((agent) => [agent.id, agent.name])),
        badRole: (role, roles) => `Unknown role ${role}; use one of: ${roles}`,
        badTier: (tier, tiers) => `Unknown tier ${tier}; use one of: ${tiers}`,
        noName: 'Give the member a name first',
        nameTaken: (name) => `There is already a member called "${name}": choose another name`,
        needProject: 'Choose the project first for a member that works only in one project',
        untrusted: (project) =>
            `The project ${project} is not trusted yet, and its member files (.xora/agents) only count once it is: trust it on the Extensions page of Settings first`,
        projectMissing: (folder) => `The project folder does not exist: ${folder}`,
        projectGone: 'The project is gone',
        notFound: (id) => `There is no member ${id}`,
        notInProject: (name, project) =>
            `${name} is not a member in the project ${project}: a member of another project cannot work here`,
        builtinStays: (name) => `${name} is built in and cannot be deleted; if you changed it, reset it instead`,
        routineMissing: 'There is no such routine',
        badSchedule: (error) => `The schedule cannot be read: ${error}`,
        badTimezone: (zone) => `Unknown time zone ${zone}`,
        subscriptionOnly: (tier) =>
            `Nobody watches a routine, so it only uses pay-as-you-go models (api, local or custom); the ${tier} tier and the default model are subscription quotas: connect a pay-as-you-go model for the tier in Settings`,
        memoryTitle: (name) => `Memory: ${name}`,
        memory: (name, project, notes) =>
            [
                `This is ${name}'s long-term memory: notes you wrote yourself with remember while working before, each starting with the project and the date it was written in${project ? ` (you are in the project "${project}" now)` : ''}. A note from another project may not apply here; when a note does not match what you see now, trust what you see and correct the note with remember.`,
                '',
                notes,
                '',
                'When you learn something that will matter again, write a note with remember: facts about the project (how to build and test it, its layout and conventions), the user’s preferences and requirements, approaches that worked or failed. One sentence each, clear on its own. Never note keys, tokens or passwords, or details that only matter this once.',
            ].join('\n'),
        noNotes: '(no notes yet)',
        olderOmitted: '(older notes are left out)',
        contextTitle: 'How you work here',
        context:
            'You are not in a team run: there is no task card, supervisor or deliverable here, and no team tools such as deliver or ask_supervisor. Leave out what your instructions say about task cards, the deliverable JSON and reporting to the supervisor; the rest of how you work still holds. Answer in plain prose: the conclusion first, then its evidence.',
        rememberTool:
            'Writes something that will matter again into your long-term memory, which you get with every task: facts about the project (how to build and test it, its layout and conventions), the user’s preferences and requirements, approaches that worked or failed. One sentence, clear on its own. Never note keys, tokens or passwords, or details that only matter this once. To correct a wrong or outdated note, name it with replaces.',
        rememberNote: 'The note: one sentence, at most 500 characters',
        rememberReplaces: 'Some words of the note it replaces; leave it out to add a new note',
        noted: 'Noted.',
        replaced: 'Replaced the old note.',
        already: 'That is noted already.',
        dropped: (count) =>
            `The memory went over ${MEMORY_FILE_CHARS} characters, so the oldest ${count === 1 ? 'note was' : `${count} notes were`} dropped.`,
        noteMissing: '`note` must be a sentence that is not empty',
        noteTooLong: (length) => `The note has ${length} characters, over ${NOTE_CHARS}: write it shorter`,
        noteSecret:
            'The note looks like it holds a key, token or password, so it was not written: those never go into memory',
        noMatch: (part) => `No note contains "${part}"; nothing was changed`,
        unavailable: (name) => `Tool ${name} is not available here`,
        chatTitle: (name, text) => `${name}: ${text}`,
        routineTitle: (title) => `Routine: ${title}`,
        routinePrompt: (title, instruction) =>
            [
                `Routine: ${title}`,
                '',
                'Nobody is watching this run. Do what can be done; what cannot (a permission, information or a confirmation is missing) you skip instead of waiting, and say why in the report.',
                '',
                'What to do:',
                instruction,
                '',
                'Finish with a report in these three sections, all three headings included:',
                '## Conclusion',
                'What came of it, the most important finding or result (key numbers, file paths); if it did not work, say so plainly.',
                '## Problems',
                'What a person must know or deal with, one line each starting with "- "; "- None" when there is nothing.',
                '## Next steps',
                'What to do next, most important first, one line each starting with "- ".',
            ].join('\n'),
    },
);

type UiPeer = RpcPeer<HostMethods, HostNotifications>;
type Layer = NonNullable<HostToolProvider['layers']>[number];

/** A routine as its file keeps it. */
interface RoutineRecord {
    readonly id: string;
    readonly title: string;
    readonly schedule: string;
    readonly timezone?: string;
    readonly projectId: string;
    readonly instruction: string;
    readonly enabled: boolean;
    readonly lastRunAt?: number;
    readonly lastThreadId?: string;
    /** The latest schedule time handled, so a restart neither runs it twice nor forgets a missed one. */
    readonly lastScheduledAt?: number;
    /** Why the last run did not start. */
    readonly failure?: string;
}

interface RoutinesFile {
    readonly memberId: string;
    readonly routines: RoutineRecord[];
}

/** An agent file and the member it defines: its frontmatter `id`, else its file name. */
interface AgentFile {
    readonly file: string;
    readonly id: string;
    readonly scope: 'user' | 'project';
}

interface Roster {
    readonly org: Organization;
    /** The file in force for each member id; a project file wins over the user's. */
    readonly files: ReadonlyMap<string, AgentFile>;
}

export interface MemberInput {
    readonly id?: string | undefined;
    readonly name: string;
    readonly role: string;
    readonly category?: string | undefined;
    readonly tier: string;
    readonly mode: PermissionMode;
    readonly description?: string | undefined;
    readonly prompt: string;
    readonly tools?: readonly string[] | undefined;
}

export interface RoutineInput {
    readonly id?: string | undefined;
    readonly title: string;
    readonly schedule: string;
    readonly timezone?: string | undefined;
    readonly projectId: string;
    readonly instruction: string;
    readonly enabled: boolean;
}

export interface MemberDeps {
    readonly threads: ThreadStore;
    readonly turns: TurnService;
    readonly projects: ProjectService;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly bus: Bus;
    readonly log: Logger;
    /** `<data>/orgs`: user-level agent files are in `default/agents/`. */
    readonly orgsDir: string;
    /** `<data>/members`: each member's `memory.md` and `routines.json`. */
    readonly membersDir: string;
    /** Routines changed: their schedules go to the trigger service again. */
    readonly onRoutinesChanged?: () => void;
    readonly now?: () => number;
}

const BUILTIN_IDS = new Set(DEFAULT_ORG.roster.map((agent) => agent.id));

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * A member's name: a built-in member the user has not renamed goes by its name in the host language (主管, 侦察…),
 * any other by the name its file gives.
 */
export function memberName(agent: Pick<AgentSpec, 'id' | 'name'>): string {
    const builtin = DEFAULT_ORG.roster.find((spec) => spec.id === agent.id);
    return builtin && builtin.name === agent.name ? (textOf(TEXT).names[agent.id] ?? agent.name) : agent.name;
}

/** The member a thread works as: its `agentId`, without the task suffix team runs add (`coder-T1` is `coder`). */
export function memberIdOf(thread: Pick<ThreadMeta, 'agentId' | 'taskId' | 'teamRunId'>): string | undefined {
    const id = thread.agentId;
    if (!id) return undefined;
    return thread.teamRunId && thread.taskId && id.endsWith(`-${thread.taskId}`)
        ? id.slice(0, -thread.taskId.length - 1)
        : id;
}

/** The trigger key of a routine. */
export function routineKey(memberId: string, routineId: string): string {
    return `${ROUTINE_KEY}${memberId}:${routineId}`;
}

/** The member and routine of a trigger key, or undefined for a workflow's key. */
export function parseRoutineKey(key: string): { memberId: string; routineId: string } | undefined {
    if (!key.startsWith(ROUTINE_KEY)) return undefined;
    const rest = key.slice(ROUTINE_KEY.length);
    const split = rest.lastIndexOf(':');
    return split > 0 ? { memberId: rest.slice(0, split), routineId: rest.slice(split + 1) } : undefined;
}

/** A member's folder: its id when that is a safe file name, else a hash of it. */
function folderName(id: string): string {
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) && !id.includes('..')
        ? id
        : `x-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** A frontmatter value in single quotes, which the frontmatter parser reads back as it was. */
function quoted(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/** An agent file as load.ts reads it: frontmatter, then the prompt as the body (none keeps the built-in one). */
export function agentFileText(
    fields: Omit<MemberInput, 'prompt' | 'id' | 'role' | 'tier'> & { id: string; role: string; tier: string },
    body: string,
): string {
    const lines = ['---', `id: ${quoted(fields.id)}`, `name: ${quoted(oneLine(fields.name))}`, `role: ${fields.role}`];
    if (fields.category) lines.push(`category: ${quoted(oneLine(fields.category).toLowerCase())}`);
    lines.push(`tier: ${fields.tier}`, `mode: ${fields.mode}`);
    if (fields.description && oneLine(fields.description)) {
        lines.push(`description: ${quoted(oneLine(fields.description))}`);
    }
    if (fields.tools) lines.push(`tools: [${fields.tools.map((tool) => quoted(tool.trim())).join(', ')}]`);
    lines.push('---');
    return `${lines.join('\n')}\n${body ? `\n${body}\n` : ''}`;
}

/** The agent files of a folder with the member id each defines, as load.ts applies them (sorted by name). */
async function agentFiles(dir: string, scope: AgentFile['scope']): Promise<AgentFile[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const files: AgentFile[] = [];
    for (const name of names.filter((entry) => entry.toLowerCase().endsWith('.md')).sort()) {
        const file = path.join(dir, name);
        try {
            const { data } = parseFrontmatter(await readFile(file, 'utf8'));
            const given = typeof data.id === 'string' || typeof data.id === 'number' ? String(data.id).trim() : '';
            files.push({ file, id: given || name.replace(/\.md$/i, ''), scope });
        } catch {
            // Unreadable: the organization loader reports it.
        }
    }
    return files;
}

async function writeAtomic(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
}

function today(at: number): string {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A note line's own words, without its `- [project date]` tag. */
function noteText(line: string): string {
    return line
        .replace(/^\s*[-*]\s*/, '')
        .replace(/^\[[^\]\n]*\]\s*/, '')
        .trim();
}

/** The latest notes that fit in `limit` characters, and whether older ones were left out. */
function recentNotes(text: string, limit: number): { text: string; omitted: boolean } {
    const trimmed = text.trim();
    if (trimmed.length <= limit) return { text: trimmed, omitted: false };
    const kept: string[] = [];
    let size = 0;
    for (const line of trimmed.split('\n').reverse()) {
        if (size + line.length + 1 > limit) break;
        kept.unshift(line);
        size += line.length + 1;
    }
    return { text: kept.join('\n').trim(), omitted: true };
}

function rememberTool(): HostToolProvider['tools'][number] {
    const text = textOf(TEXT);
    return {
        name: REMEMBER_TOOL,
        description: text.rememberTool,
        parameters: {
            type: 'object',
            properties: {
                note: { type: 'string', description: text.rememberNote },
                replaces: { type: 'string', description: text.rememberReplaces },
            },
            required: ['note'],
            additionalProperties: false,
        },
        kind: 'other',
    };
}

function readRecord(value: unknown): RoutineRecord | undefined {
    const entry = (value ?? {}) as Record<string, unknown>;
    const texts = ['id', 'title', 'schedule', 'projectId', 'instruction'] as const;
    if (texts.some((key) => typeof entry[key] !== 'string') || typeof entry.enabled !== 'boolean') {
        return undefined;
    }
    const number = (key: string) => (typeof entry[key] === 'number' ? { [key]: entry[key] as number } : {});
    const string = (key: string) => (typeof entry[key] === 'string' ? { [key]: entry[key] as string } : {});
    return {
        id: entry.id as string,
        title: entry.title as string,
        schedule: entry.schedule as string,
        projectId: entry.projectId as string,
        instruction: entry.instruction as string,
        enabled: entry.enabled as boolean,
        ...string('timezone'),
        ...number('lastRunAt'),
        ...string('lastThreadId'),
        ...number('lastScheduledAt'),
        ...string('failure'),
    };
}

export class MemberService {
    readonly #deps: MemberDeps;
    /** File work of one member (`memory:<id>`, `routines:<id>`) runs one after another. */
    readonly #queues = new Map<string, Promise<unknown>>();
    /** Names of the projects seen, for memory layers built where only the id is at hand. */
    readonly #projectNames = new Map<string, string>();
    #enabledRoutines = 0;

    constructor(deps: MemberDeps) {
        this.#deps = deps;
    }

    #now(): number {
        return this.#deps.now?.() ?? Date.now();
    }

    // Members ------------------------------------------------------------------------------------------------

    /** The members of a project's organization; without a project, the built-in ones and the user's. */
    async list(projectId?: string): Promise<Member[]> {
        const project = projectId ? await this.#deps.projects.get(projectId) : undefined;
        const roster = await this.#roster(project);
        return Promise.all(roster.org.roster.map((agent) => this.#view(agent, roster.files.get(agent.id))));
    }

    /** Creates or changes a member's agent file (06 §19): the user's for every project, or the project's. */
    async save(input: { projectId?: string; scope: 'user' | 'project'; member: MemberInput }): Promise<Member> {
        const text = textOf(TEXT);
        const given = input.member;
        const role = ROLES.find((value) => value === given.role);
        if (!role) {
            throw new RpcError(RpcErrorCode.InvalidParams, text.badRole(given.role, ROLES.join(', ')));
        }
        const tier = TIERS.find((value) => value === given.tier);
        if (!tier) {
            throw new RpcError(RpcErrorCode.InvalidParams, text.badTier(given.tier, TIERS.join(', ')));
        }
        const name = oneLine(given.name);
        if (!name) {
            throw new RpcError(RpcErrorCode.InvalidParams, text.noName);
        }
        const project = input.projectId ? await this.#project(input.projectId) : undefined;
        if (input.scope === 'project') {
            if (!project) {
                throw new RpcError(RpcErrorCode.InvalidParams, text.needProject);
            }
            if (!project.trusted) {
                throw new RpcError(RpcErrorCode.Rejected, text.untrusted(project.name));
            }
        }
        const roster = await this.#roster(project);
        let id: string;
        if (given.id !== undefined) {
            id = given.id;
            if (!roster.org.roster.some((agent) => agent.id === id) && !BUILTIN_IDS.has(id)) {
                throw new RpcError(RpcErrorCode.NotFound, text.notFound(id));
            }
        } else {
            id = this.#newId(name, roster);
        }
        // Agent files override a member of the same name, and `@` mentions go by name: names are unique.
        const lower = name.toLowerCase();
        if (
            roster.org.roster.some(
                (agent) =>
                    agent.id !== id &&
                    (agent.name.toLowerCase() === lower || memberName(agent).toLowerCase() === lower),
            )
        ) {
            throw new RpcError(RpcErrorCode.Rejected, text.nameTaken(name));
        }
        const dir =
            input.scope === 'project' && project
                ? path.join(project.path, '.xora', 'agents')
                : path.join(this.#deps.orgsDir, 'default', 'agents');
        // The file that already defines it in this scope keeps its name; a new one is `<id>.md`.
        const existing = (await agentFiles(dir, input.scope)).filter((file) => file.id === id).at(-1);
        const file = existing?.file ?? path.join(dir, `${folderName(id)}.md`);
        const builtin = DEFAULT_ORG.roster.find((agent) => agent.id === id);
        const prompt = given.prompt.replace(/\r\n?/g, '\n').trim();
        // A built-in member's prompt left as it is stays out of the file, so it follows the app's updates.
        const body = builtin && prompt === builtin.prompt.trim() ? '' : prompt;
        await writeAtomic(
            file,
            agentFileText(
                {
                    id,
                    name,
                    role,
                    ...(given.category ? { category: given.category } : {}),
                    tier,
                    mode: given.mode,
                    ...(given.description ? { description: given.description } : {}),
                    ...(given.tools ? { tools: given.tools } : {}),
                },
                body,
            ),
        );
        // A member moved to the other scope lives only where the user put it now.
        const before = roster.files.get(id);
        if (given.id !== undefined && before && before.scope !== input.scope) {
            await unlink(before.file).catch(() => undefined);
        }
        this.#deps.log.info(`member ${id} saved in ${file}`);
        this.#changed(id);
        return this.#member(id, project?.id);
    }

    /** Deletes a member's file: a member the user made goes, with its routines; a changed built-in one is reset. */
    async remove(memberId: string, projectId?: string): Promise<void> {
        const text = textOf(TEXT);
        const project = projectId ? await this.#deps.projects.get(projectId) : undefined;
        const roster = await this.#roster(project);
        const agent = roster.org.roster.find((item) => item.id === memberId);
        const file = roster.files.get(memberId);
        if (!file) {
            if (agent && BUILTIN_IDS.has(memberId)) {
                throw new RpcError(RpcErrorCode.Rejected, text.builtinStays(memberName(agent)));
            }
            throw new RpcError(RpcErrorCode.NotFound, text.notFound(memberId));
        }
        await unlink(file.file);
        this.#deps.log.info(`member ${memberId}: removed ${file.file}`);
        // Gone from the user's members and the project's: its routines stop. Its memory stays.
        const after = await this.#roster(project);
        if (!after.org.roster.some((item) => item.id === memberId)) {
            await this.#serial(`routines:${memberId}`, () => rm(this.#routinesFile(memberId), { force: true }));
            this.#deps.onRoutinesChanged?.();
        }
        this.#changed(memberId);
    }

    /** The threads a member works or worked in, in every project, newest first. */
    threads(memberId: string, limit = DEFAULT_THREAD_LIMIT): ThreadMeta[] {
        return this.#deps.threads
            .list({ includeArchived: false })
            .filter((thread) => memberIdOf(thread) === memberId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit);
    }

    /** The organization of a project with each member's display name, for `@` mentions and the `agent` tool. */
    async roster(projectId: string): Promise<{ org: Organization; project: Project; members: AgentSpec[] }> {
        const project = await this.#deps.projects.get(projectId);
        const { org } = await this.#roster(project);
        return { org, project, members: [...org.roster] };
    }

    async #view(agent: AgentSpec, file: AgentFile | undefined): Promise<Member> {
        const builtin = BUILTIN_IDS.has(agent.id);
        const [memory, routines] = await Promise.all([this.#memoryStats(agent.id), this.#routineViews(agent.id)]);
        return {
            id: agent.id,
            name: memberName(agent),
            role: agent.role,
            ...(agent.category ? { category: agent.category } : {}),
            tier: agent.tier,
            mode: agent.mode,
            ...(agent.description ? { description: agent.description } : {}),
            prompt: agent.prompt,
            ...(agent.tools ? { tools: [...agent.tools] } : {}),
            source: builtin ? 'builtin' : file?.scope === 'project' ? 'project' : 'user',
            customized: builtin && file !== undefined,
            ...(file ? { file: file.file } : {}),
            memory,
            routines,
        };
    }

    /** A member as the list of `projectId` shows it, else as the user's list does. */
    async #member(memberId: string, projectId?: string): Promise<Member> {
        const found =
            (projectId ? (await this.list(projectId)).find((member) => member.id === memberId) : undefined) ??
            (await this.list()).find((member) => member.id === memberId);
        if (!found) {
            throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).notFound(memberId));
        }
        return found;
    }

    async #roster(project?: Project): Promise<Roster> {
        const userDir = path.join(this.#deps.orgsDir, 'default');
        if (project) this.#projectNames.set(project.id, project.name);
        const loaded = project
            ? await loadTeamOrganization({
                  orgsDir: this.#deps.orgsDir,
                  projectDir: project.path,
                  trusted: project.trusted,
              })
            : await loadOrganization({ userDir });
        const files = new Map<string, AgentFile>();
        for (const file of await agentFiles(path.join(userDir, 'agents'), 'user')) {
            files.set(file.id, file);
        }
        if (project?.trusted) {
            for (const file of await agentFiles(path.join(project.path, '.xora', 'agents'), 'project')) {
                files.set(file.id, file);
            }
        }
        return { org: loaded.org, files };
    }

    async #project(projectId: string): Promise<Project> {
        const project = await this.#deps.projects.get(projectId);
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).projectMissing(project.path));
        }
        this.#projectNames.set(project.id, project.name);
        return project;
    }

    /**
     * The id of a new member: its name as `[a-z0-9-]` when that has a letter, else `member-<6 hex>`; never one in use
     * or one with a memory folder left from an earlier member.
     */
    #newId(name: string, roster: Roster): string {
        const taken = (id: string) =>
            BUILTIN_IDS.has(id) ||
            roster.org.roster.some((agent) => agent.id === id) ||
            roster.files.has(id) ||
            existsSync(path.join(this.#deps.membersDir, folderName(id)));
        const slug = name
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+/, '')
            .slice(0, ID_LENGTH)
            .replace(/-+$/, '');
        if (/[a-z]/.test(slug)) {
            if (!taken(slug)) return slug;
            for (let count = 2; count < 100; count++) {
                const suffix = `-${count}`;
                const candidate = `${slug.slice(0, ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
                if (!taken(candidate)) return candidate;
            }
        }
        for (;;) {
            const candidate = `member-${randomBytes(3).toString('hex')}`;
            if (!taken(candidate)) return candidate;
        }
    }

    #changed(memberId: string): void {
        this.#deps.bus.broadcast('member.changed', { memberId });
    }

    #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
        const next = (this.#queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
        this.#queues.set(key, next);
        void next
            .finally(() => {
                if (this.#queues.get(key) === next) this.#queues.delete(key);
            })
            .catch(() => undefined);
        return next;
    }

    // Memory -------------------------------------------------------------------------------------------------

    #memoryFile(memberId: string): string {
        return path.join(this.#deps.membersDir, folderName(memberId), 'memory.md');
    }

    async memory(memberId: string): Promise<{ text: string; updatedAt?: number }> {
        const file = this.#memoryFile(memberId);
        try {
            const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
            return { text, updatedAt: Math.round(info.mtimeMs) };
        } catch {
            return { text: '' };
        }
    }

    /** The user edits or clears a member's memory. */
    async setMemory(memberId: string, text: string): Promise<void> {
        const file = this.#memoryFile(memberId);
        const tidy = text.replace(/\r\n?/g, '\n').trim();
        await this.#serial(`memory:${memberId}`, () =>
            tidy ? writeAtomic(file, `${tidy}\n`) : rm(file, { force: true }),
        );
        this.#changed(memberId);
    }

    async #memoryStats(memberId: string): Promise<Member['memory']> {
        const memory = await this.memory(memberId);
        const chars = memory.text.trim().length;
        return { chars, ...(chars > 0 && memory.updatedAt !== undefined ? { updatedAt: memory.updatedAt } : {}) };
    }

    /**
     * Gives a member's thread its memory, read afresh for every turn, and the `remember` tool (06 §19): its
     * conversations and routine runs, workflow steps, team tasks and the subagents started for it.
     */
    withMemory(provider: HostToolProvider, agent: Pick<AgentSpec, 'id' | 'name'>, projectId: string): HostToolProvider {
        const own = provider.layers ?? [];
        const name = memberName(agent);
        const layer = () => this.#memoryLayer(agent.id, name, projectId);
        return {
            ...provider,
            tools: [...provider.tools.filter((tool) => tool.name !== REMEMBER_TOOL), rememberTool()],
            get layers() {
                return [...own, layer()];
            },
            handle: (tool, input, signal) =>
                tool === REMEMBER_TOOL
                    ? this.#remember(agent.id, projectId, input)
                    : provider.handle(tool, input, signal),
        };
    }

    #memoryLayer(memberId: string, name: string, projectId: string): Layer {
        const text = textOf(TEXT);
        let saved = '';
        try {
            saved = readFileSync(this.#memoryFile(memberId), 'utf8');
        } catch {
            // No memory yet.
        }
        const recent = recentNotes(saved, MEMORY_PROMPT_CHARS);
        const notes = recent.text ? `${recent.omitted ? `${text.olderOmitted}\n` : ''}${recent.text}` : text.noNotes;
        return {
            id: 'member_memory',
            title: text.memoryTitle(name),
            text: text.memory(name, this.#projectName(projectId), notes),
        };
    }

    #projectName(projectId: string): string | undefined {
        const known = this.#projectNames.get(projectId);
        if (known) return known;
        try {
            return path.basename(this.#deps.projects.rootOf(projectId));
        } catch {
            return undefined;
        }
    }

    /** The `remember` tool: a note appended or put in place of an old one; the oldest go past the size limit. */
    async #remember(memberId: string, projectId: string, input: unknown): Promise<HostToolResult> {
        const text = textOf(TEXT);
        const args = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
        const note = typeof args.note === 'string' ? oneLine(args.note) : '';
        if (!note) return { content: text.noteMissing, isError: true };
        if (note.length > NOTE_CHARS) return { content: text.noteTooLong(note.length), isError: true };
        if (redact(note) !== note) return { content: text.noteSecret, isError: true };
        const replaces = typeof args.replaces === 'string' ? oneLine(args.replaces) : '';
        const project = await this.#deps.projects.get(projectId).catch(() => undefined);
        if (project) this.#projectNames.set(project.id, project.name);
        const tag = `[${project?.name ?? this.#projectName(projectId) ?? projectId} ${today(this.#now())}]`;
        const file = this.#memoryFile(memberId);
        const result = await this.#serial(`memory:${memberId}`, async (): Promise<HostToolResult> => {
            const saved = await readFile(file, 'utf8').catch(() => '');
            const lines = saved
                .replace(/\r\n?/g, '\n')
                .split('\n')
                .filter((line) => line.trim() !== '');
            const line = `- ${tag} ${note}`;
            let message: string = text.noted;
            if (replaces) {
                const index = lines.findIndex((item) => noteText(item).toLowerCase().includes(replaces.toLowerCase()));
                if (index < 0) return { content: text.noMatch(replaces), isError: true };
                lines[index] = line;
                message = text.replaced;
            } else if (lines.some((item) => noteText(item).toLowerCase() === note.toLowerCase())) {
                return { content: text.already };
            } else {
                lines.push(line);
            }
            let dropped = 0;
            while (lines.length > 1 && lines.join('\n').length + 1 > MEMORY_FILE_CHARS) {
                lines.shift();
                dropped++;
            }
            await writeAtomic(file, `${lines.join('\n')}\n`);
            return { content: dropped > 0 ? `${message} ${text.dropped(dropped)}` : message };
        });
        if (!result.isError) {
            this.#deps.log.info(`member ${memberId} remembered a note in ${projectId}`);
            this.#changed(memberId);
        }
        return result;
    }

    // Working as a member ------------------------------------------------------------------------------------

    /**
     * How a member works in a thread of its own (a conversation, a routine run, a subagent started for it): its
     * organization and agent layers, a note that it is not in a team run, its tool whitelist, its memory and
     * `remember`. `layers` go after those, e.g. a subagent's brief.
     */
    provider(
        agent: AgentSpec,
        org: Organization,
        projectId: string,
        options: { layers?: readonly Layer[]; highRiskApproval?: boolean } = {},
    ): HostToolProvider {
        const text = textOf(TEXT);
        const base: HostToolProvider = {
            tools: [],
            disabledTools: disabledBuiltins(agent),
            mcpTools: mcpToolsOf(agent),
            layers: [
                ...systemLayers(org, { ...agent, name: memberName(agent) }),
                { id: 'member_context', title: text.contextTitle, text: text.context },
                ...(options.layers ?? []),
            ],
            ...(options.highRiskApproval ? { highRiskApproval: true } : {}),
            handle: async (name) => ({ content: textOf(TEXT).unavailable(name), isError: true }),
        };
        return this.withMemory(base, agent, projectId);
    }

    /** A conversation with a member: a new thread in the project where it works as itself, started with `text`. */
    async chat(input: { projectId: string; memberId: string; text: string }): Promise<ThreadMeta> {
        const { threads, turns, log } = this.#deps;
        const text = textOf(TEXT);
        const project = await this.#project(input.projectId);
        const { org } = await this.#roster(project);
        const agent = org.roster.find((item) => item.id === input.memberId);
        if (!agent) {
            throw new RpcError(RpcErrorCode.NotFound, text.notInProject(input.memberId, project.name));
        }
        const pick = pickTierModel(this.#deps, { org, project, tier: agent.tier, unattended: false, warnings: [] });
        const thread = threads.create({
            projectId: project.id,
            title: text.chatTitle(memberName(agent), shorten(input.text, 20)),
            engine: 'xora',
            model: pick.ref,
            mode: agent.mode,
            effort: pick.effort,
            extra: { agentId: agent.id, role: agent.role, tier: agent.tier },
        });
        turns.setHostTools(thread.id, this.provider(agent, org, project.id));
        await this.#open(thread, input.text);
        log.info(`member ${agent.id} talks in ${thread.id}`);
        // Its page lists its work.
        this.#changed(agent.id);
        return threads.get(thread.id);
    }

    /** Starts the first turn; a thread that cannot start (no model, a spent budget) does not stay behind empty. */
    async #open(thread: ThreadMeta, text: string): Promise<void> {
        const { threads, turns } = this.#deps;
        try {
            await turns.start(thread.id, text);
        } catch (error) {
            turns.setHostTools(thread.id, undefined);
            threads.delete(thread.id);
            throw error;
        }
    }

    /**
     * Host tools live in memory: after a restart the member threads that are not part of a team or workflow run
     * (conversations, routine runs, subagents started for a member) work as their member again.
     */
    async restore(): Promise<void> {
        const rosters = new Map<string, Promise<{ org: Organization } | undefined>>();
        for (const thread of this.#deps.threads.list({ includeArchived: false })) {
            if (!thread.agentId || !thread.role || thread.teamRunId || thread.workflowRunId) continue;
            if (thread.engine !== 'xora') continue;
            let roster = rosters.get(thread.projectId);
            if (!roster) {
                roster = this.#deps.projects
                    .get(thread.projectId)
                    .then((project) => (project.missing ? undefined : this.#roster(project)))
                    .catch(() => undefined);
                rosters.set(thread.projectId, roster);
            }
            const org = (await roster)?.org;
            const agent = org?.roster.find((item) => item.id === thread.agentId);
            if (org && agent) {
                this.#deps.turns.setHostTools(thread.id, this.provider(agent, org, thread.projectId));
            }
        }
    }

    // Routines -----------------------------------------------------------------------------------------------

    #routinesFile(memberId: string): string {
        return path.join(this.#deps.membersDir, folderName(memberId), 'routines.json');
    }

    async #readRoutines(file: string): Promise<RoutinesFile | undefined> {
        try {
            const data = JSON.parse(await readFile(file, 'utf8')) as { memberId?: unknown; routines?: unknown };
            if (typeof data.memberId !== 'string' || !Array.isArray(data.routines)) return undefined;
            return {
                memberId: data.memberId,
                routines: data.routines.flatMap((entry) => readRecord(entry) ?? []),
            };
        } catch {
            return undefined;
        }
    }

    async #routines(memberId: string): Promise<RoutineRecord[]> {
        return (await this.#readRoutines(this.#routinesFile(memberId)))?.routines ?? [];
    }

    /** Changes a member's routines in one go, reading the file fresh. */
    #editRoutines<T>(memberId: string, change: (records: RoutineRecord[]) => T): Promise<T> {
        return this.#serial(`routines:${memberId}`, async () => {
            const records = await this.#routines(memberId);
            const result = change(records);
            const file = this.#routinesFile(memberId);
            if (records.length === 0) {
                await rm(file, { force: true });
            } else {
                await writeAtomic(file, `${JSON.stringify({ memberId, routines: records }, null, 2)}\n`);
            }
            return result;
        });
    }

    async #routineViews(memberId: string): Promise<MemberRoutine[]> {
        const records = await this.#routines(memberId);
        return Promise.all(records.map((record) => this.#routineView(record)));
    }

    async #routineView(record: RoutineRecord): Promise<MemberRoutine> {
        const problem = (await this.#routineProblem(record)) ?? record.failure;
        let nextRunAt: number | undefined;
        if (record.enabled && !cronError(record.schedule) && !(record.timezone && !isTimeZone(record.timezone))) {
            nextRunAt = nextCronTime(parseCron(record.schedule), this.#now(), record.timezone)?.getTime();
        }
        return {
            id: record.id,
            title: record.title,
            schedule: record.schedule,
            ...(record.timezone ? { timezone: record.timezone } : {}),
            projectId: record.projectId,
            instruction: record.instruction,
            enabled: record.enabled,
            ...(record.lastRunAt !== undefined ? { lastRunAt: record.lastRunAt } : {}),
            ...(record.lastThreadId ? { lastThreadId: record.lastThreadId } : {}),
            ...(nextRunAt !== undefined ? { nextRunAt } : {}),
            ...(problem ? { problem } : {}),
        };
    }

    /** What keeps a routine from running at all: a schedule or time zone that cannot be read, a project gone. */
    async #routineProblem(record: Pick<RoutineRecord, 'schedule' | 'timezone' | 'projectId'>) {
        const text = textOf(TEXT);
        const error = cronError(record.schedule);
        if (error) return text.badSchedule(error);
        if (record.timezone && !isTimeZone(record.timezone)) return text.badTimezone(record.timezone);
        const project = await this.#deps.projects.get(record.projectId).catch(() => undefined);
        if (!project) return text.projectGone;
        if (project.missing) return text.projectMissing(project.path);
        return undefined;
    }

    /**
     * Creates or changes a routine. A schedule that cannot be read or a project that is gone is saved with its
     * `problem`; a member that is not in the routine's project is refused.
     */
    async saveRoutine(memberId: string, given: RoutineInput): Promise<Member> {
        const text = textOf(TEXT);
        const project = await this.#deps.projects.get(given.projectId).catch(() => undefined);
        const usable = project && !project.missing ? project : undefined;
        const roster = await this.#roster(usable);
        const agent = roster.org.roster.find((item) => item.id === memberId);
        if (!agent) {
            throw usable
                ? new RpcError(RpcErrorCode.Rejected, text.notInProject(memberId, usable.name))
                : new RpcError(RpcErrorCode.NotFound, text.notFound(memberId));
        }
        const now = this.#now();
        await this.#editRoutines(memberId, (records) => {
            const index = given.id ? records.findIndex((record) => record.id === given.id) : -1;
            if (given.id && index < 0) {
                throw new RpcError(RpcErrorCode.NotFound, text.routineMissing);
            }
            const previous = index >= 0 ? records[index] : undefined;
            const timezone = given.timezone?.trim();
            // Switched on (or new): times before now are not missed runs.
            const fresh = !previous || (!previous.enabled && given.enabled);
            const record: RoutineRecord = {
                id: previous?.id ?? newId('r'),
                title: oneLine(given.title),
                schedule: oneLine(given.schedule),
                ...(timezone ? { timezone } : {}),
                projectId: given.projectId,
                instruction: given.instruction.replace(/\r\n?/g, '\n').trim(),
                enabled: given.enabled,
                ...(previous?.lastRunAt !== undefined ? { lastRunAt: previous.lastRunAt } : {}),
                ...(previous?.lastThreadId ? { lastThreadId: previous.lastThreadId } : {}),
                ...(fresh
                    ? { lastScheduledAt: now }
                    : previous?.lastScheduledAt !== undefined
                      ? { lastScheduledAt: previous.lastScheduledAt }
                      : {}),
            };
            if (index >= 0) records[index] = record;
            else records.push(record);
        });
        this.#deps.onRoutinesChanged?.();
        this.#changed(memberId);
        return this.#member(memberId, usable?.id);
    }

    async deleteRoutine(memberId: string, routineId: string): Promise<Member> {
        const removed = await this.#editRoutines(memberId, (records) => {
            const index = records.findIndex((record) => record.id === routineId);
            if (index < 0) {
                throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).routineMissing);
            }
            return records.splice(index, 1)[0];
        });
        this.#deps.onRoutinesChanged?.();
        this.#changed(memberId);
        const project = await this.#deps.projects.get(removed?.projectId ?? '').catch(() => undefined);
        return this.#member(memberId, project && !project.missing ? project.id : undefined);
    }

    /** Runs a routine now, whatever its schedule; returns the run's thread. */
    async runRoutine(memberId: string, routineId: string): Promise<ThreadMeta> {
        const record = (await this.#routines(memberId)).find((item) => item.id === routineId);
        if (!record) {
            throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).routineMissing);
        }
        return this.#run(memberId, record);
    }

    /** Schedules of the switched-on routines that can run, for the trigger service (06 §12). */
    async triggerTargets(): Promise<TriggerTarget[]> {
        let folders: string[];
        try {
            folders = await readdir(this.#deps.membersDir);
        } catch {
            this.#enabledRoutines = 0;
            return [];
        }
        const targets: TriggerTarget[] = [];
        for (const folder of folders) {
            const saved = await this.#readRoutines(path.join(this.#deps.membersDir, folder, 'routines.json'));
            for (const record of saved?.routines ?? []) {
                if (!saved || !record.enabled || (await this.#routineProblem(record))) continue;
                const project = await this.#deps.projects.get(record.projectId);
                targets.push({
                    key: routineKey(saved.memberId, record.id),
                    projectDir: project.path,
                    spec: {
                        manual: false,
                        schedule: record.schedule,
                        ...(record.timezone ? { timezone: record.timezone } : {}),
                        missed: 'once',
                        webhook: false,
                        offPeakOnly: false,
                    },
                    ...(record.lastScheduledAt !== undefined ? { lastScheduledAt: record.lastScheduledAt } : {}),
                });
            }
        }
        this.#enabledRoutines = targets.length;
        return targets;
    }

    /** Routines on a schedule as of the last sync: they keep the app running in the background. */
    get enabledRoutines(): number {
        return this.#enabledRoutines;
    }

    /**
     * A routine's schedule fired: it runs unless it was switched off or its last run is still going. A run that
     * cannot start leaves the reason on the routine instead of failing anything.
     */
    async fire(key: string, scheduledFor?: number): Promise<ThreadMeta | undefined> {
        const parsed = parseRoutineKey(key);
        if (!parsed) return undefined;
        const { memberId, routineId } = parsed;
        const { log, turns } = this.#deps;
        const record = await this.#editRoutines(memberId, (records) => {
            const index = records.findIndex((item) => item.id === routineId);
            const found = records[index];
            if (found && scheduledFor !== undefined) {
                records[index] = { ...found, lastScheduledAt: scheduledFor };
            }
            return found;
        });
        if (!record?.enabled) return undefined;
        if (record.lastThreadId && turns.isRunning(record.lastThreadId)) {
            log.info(`routine ${routineId} of ${memberId}: skipped, its last run is still going`);
            return undefined;
        }
        try {
            return await this.#run(memberId, record);
        } catch (error) {
            const failure = errorText(error);
            log.warn(`routine ${routineId} of ${memberId}: not started: ${failure}`);
            await this.#editRoutines(memberId, (records) => {
                const index = records.findIndex((item) => item.id === routineId);
                const found = records[index];
                if (found) records[index] = { ...found, failure };
            });
            this.#changed(memberId);
            return undefined;
        }
    }

    /**
     * A routine run: a new thread where the member works on the routine's instruction, unattended (06 §12): a
     * pay-as-you-go model, no full access, a person approves every high-risk action, and the report ends in the
     * three headings of a brief.
     */
    async #run(memberId: string, record: RoutineRecord): Promise<ThreadMeta> {
        const { threads, turns, connections, log } = this.#deps;
        const text = textOf(TEXT);
        const project = await this.#deps.projects.get(record.projectId).catch(() => undefined);
        if (!project) {
            throw new RpcError(RpcErrorCode.Rejected, text.projectGone);
        }
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, text.projectMissing(project.path));
        }
        this.#projectNames.set(project.id, project.name);
        const { org } = await this.#roster(project);
        const agent = org.roster.find((item) => item.id === memberId);
        if (!agent) {
            throw new RpcError(RpcErrorCode.Rejected, text.notInProject(memberId, project.name));
        }
        const pick = pickTierModel(this.#deps, { org, project, tier: agent.tier, unattended: true, warnings: [] });
        // The chain leaves subscriptions out; the default model it falls back to may still be one.
        const presetId = connections.list().find((connection) => connection.id === pick.ref.connectionId)?.presetId;
        const channel = connections.presets().find((preset) => preset.id === presetId)?.channel;
        if (channel === SUBSCRIPTION_CHANNEL) {
            throw new RpcError(RpcErrorCode.Rejected, text.subscriptionOnly(tierLabel(agent.tier, hostLanguage())));
        }
        // Nobody watches a routine: never with full access (06 §8, §12).
        const mode: PermissionMode = agent.mode === 'full' ? 'auto_edit' : agent.mode;
        const thread = threads.create({
            projectId: project.id,
            title: text.routineTitle(record.title),
            engine: 'xora',
            model: pick.ref,
            mode,
            effort: pick.effort,
            extra: { agentId: agent.id, role: agent.role, tier: agent.tier },
        });
        turns.setHostTools(thread.id, this.provider(agent, org, project.id, { highRiskApproval: true }));
        await this.#open(thread, text.routinePrompt(record.title, record.instruction));
        log.info(`routine ${record.id} of ${memberId} runs in ${thread.id}`);
        const now = this.#now();
        await this.#editRoutines(memberId, (records) => {
            const index = records.findIndex((item) => item.id === record.id);
            const found = records[index];
            if (found) {
                const { failure: _cleared, ...rest } = found;
                records[index] = { ...rest, lastRunAt: now, lastThreadId: thread.id };
            }
        });
        this.#changed(memberId);
        return threads.get(thread.id);
    }
}

/** The `member.*` handlers, registered on every UI connection. */
export function registerMemberHandlers(peer: UiPeer, members: MemberService): void {
    peer.handle('member.list', ({ projectId }) => members.list(projectId));
    peer.handle('member.save', (params) => members.save(params));
    peer.handle('member.delete', async ({ projectId, memberId }) => {
        await members.remove(memberId, projectId);
        return { ok: true } as const;
    });
    peer.handle('member.memory', ({ memberId }) => members.memory(memberId));
    peer.handle('member.setMemory', async ({ memberId, text }) => {
        await members.setMemory(memberId, text);
        return { ok: true } as const;
    });
    peer.handle('member.saveRoutine', ({ memberId, routine }) => members.saveRoutine(memberId, routine));
    peer.handle('member.deleteRoutine', ({ memberId, routineId }) => members.deleteRoutine(memberId, routineId));
    peer.handle('member.runRoutine', ({ memberId, routineId }) => members.runRoutine(memberId, routineId));
    peer.handle('member.chat', (params) => members.chat(params));
    peer.handle('member.threads', ({ memberId, limit }) => members.threads(memberId, limit));
}
