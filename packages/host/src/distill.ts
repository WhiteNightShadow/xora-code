import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    bilingual,
    type PermissionMode,
    type Project,
    parseThreadEvent,
    RpcError,
    RpcErrorCode,
    type ThreadMeta,
} from '@xora/protocol';
import { issuePath, parseWorkflow } from '@xora/workflows';
import type { Logger } from './log.ts';
import type { ProjectService } from './projects.ts';
import type { SettingsService } from './settings.ts';
import { textOf } from './text.ts';
import type { ThreadStore } from './threads.ts';
import type { TitleService } from './titles.ts';
import type { HostToolProvider, TurnService } from './turns.ts';

/**
 * Distilling a finished thread into a workflow or a skill (06 §11, 15 §6): a new thread in the same project gets
 * the old one's transcript and the extension-creator skill's formats, and saves the file with the write tool. A
 * workflow draft is checked with `workflow_check` until it parses. `workflow.draft` does the same for a workflow
 * the user describes in their own words, without a source thread.
 */

const TRANSCRIPT_LIMIT = 24_000;
const MESSAGE_LIMIT = 1_500;
const FIRST_LIMIT = 4_000;

export type DistillKind = 'workflow' | 'skill';

/** Thread role of a workflow distill thread, which gets the `workflow_check` tool. */
const DISTILL_ROLE = 'distill';

const TEXT = bilingual(
    {
        user: '## 用户',
        agent: '## agent',
        tool: (name: string, status: string, title: string, command: string | undefined) =>
            `- 工具${name}（${status}）：${title}${command !== undefined ? `：\`${command}\`` : ''}`,
        changed: (files: readonly string[]) => `- 改动的文件：${files.join('、')}`,
        failed: (message: string) => `- 这一轮失败：${message}`,
        omitted: '…（中间省略）…',
        projectMissing: (folder: string) => `项目文件夹不存在：${folder}`,
        empty: '这个线程还没有内容',
        noDescription: '先描述要写成工作流的流程',
        inProject: (file: string) => `${file}（项目根目录下）`,
        title: (kind: DistillKind, source: string) => `${kind === 'workflow' ? '沉淀工作流' : '沉淀skill'}：${source}`,
        workflowPrompt: (target: string) =>
            [
                '把下面这个线程里做成的事沉淀成一个可以反复运行的工作流。',
                '',
                '先用skill工具读extension-creator，按其中“Workflows”一节的格式起草：',
                `- 文件：${target}，name用小写字母、数字和-，文件名和name一致`,
                '- 线程里每次会变的东西（问题描述、文件、分支等）做成inputs',
                '- 每一步交给合适的agent（scout侦察、coder编码、tester测试、debugger修bug、reviewer审查、writer文档）；能用命令验收的步骤加verify',
                '- 要上网查资料的步骤（搜索、读网页、看github）交给scout，它有web_search和web_fetch',
                '- 写git相关的步骤（提交、建分支、看diff等）之前，先用bash运行`git rev-parse --is-inside-work-tree`确认项目是git仓库；不是的话不写这类步骤，并在最后的说明里讲明',
                '- 推送、发布、删除这类动作前加人工关卡（gate）',
                '- 不要写进密钥、token和本机的绝对路径',
                '',
                '写好后调用workflow_check检查，有问题就改，直到通过。最后用一两句话说明它做什么、需要哪些输入、怎么运行。',
            ].join('\n'),
        skillPrompt: (target: string) =>
            [
                '把下面这个线程里用到的做法沉淀成一个skill，以后遇到同类任务时能直接照着做。',
                '',
                '先用skill工具读extension-creator，按其中skill的格式写：',
                `- 文件：${target}，文件夹名和name一致`,
                '- description写清楚什么时候该用它（会出现的任务和关键词）',
                '- 正文写可复用的步骤、命令和注意事项，去掉这次任务特有的细节；长的参考资料放到同一文件夹的其他文件里',
                '- 不要写进密钥、token和本机的绝对路径',
                '',
                '写好后说明它会在什么情况下被用到。',
            ].join('\n'),
        draftTitle: (request: string) => `新工作流：${request}`,
        draftPrompt: (target: string) =>
            [
                '用户在下面的<request>里描述了一个要反复执行的流程，把它写成一个工作流。',
                '',
                '先用skill工具读extension-creator，按其中“Workflows”一节的格式起草：',
                `- 文件：${target}，name用小写字母、数字和-，文件名和name一致`,
                '- 每次运行会变的东西（问题描述、文件、分支等）做成inputs',
                '- 每一步交给合适的agent（scout侦察、coder编码、tester测试、debugger修bug、reviewer审查、writer文档）；能用命令验收的步骤加verify',
                '- 要上网查资料的步骤（搜索、读网页、看github）交给scout，它有web_search和web_fetch',
                '- 写git相关的步骤（提交、建分支、看diff等）之前，先用bash运行`git rev-parse --is-inside-work-tree`确认项目是git仓库；不是的话不写这类步骤，并在最后的说明里讲明',
                '- 推送、发布、删除这类动作前加人工关卡（gate）',
                '- 不要写进密钥、token和本机的绝对路径',
                '- 只有缺了必不可少的信息才问用户，其余按合理的做法定下来',
                '',
                '写好后调用workflow_check检查，有问题就改，直到通过。最后用一两句话说明它做什么、需要哪些输入，并告诉用户文件已经写好，可以到工作流看板运行。',
            ].join('\n'),
    },
    {
        user: '## User',
        agent: '## Agent',
        tool: (name, status, title, command) =>
            `- Tool ${name} (${status}): ${title}${command !== undefined ? `: \`${command}\`` : ''}`,
        changed: (files) => `- Changed files: ${files.join(', ')}`,
        failed: (message) => `- This turn failed: ${message}`,
        omitted: '… (middle omitted) …',
        projectMissing: (folder) => `The project folder does not exist: ${folder}`,
        empty: 'This thread has no content yet',
        noDescription: 'Describe the process to write as a workflow first',
        inProject: (file) => `${file} (under the project root)`,
        title: (kind, source) => `${kind === 'workflow' ? 'Save as a workflow' : 'Save as a skill'}: ${source}`,
        workflowPrompt: (target) =>
            [
                'Turn what the thread below got done into a workflow that can run again and again.',
                '',
                'First read extension-creator with the skill tool, then draft the workflow in the format of its "Workflows" section:',
                `- File: ${target}; the name uses lower-case letters, digits and -, and the file name matches the name`,
                '- What changes from one run to the next (the problem description, files, branches and so on) becomes inputs',
                '- Give every step to a fitting agent (scout explores, coder codes, tester tests, debugger fixes bugs, reviewer reviews, writer writes docs); add verify to steps a command can check',
                '- Steps that research on the web (searching, reading pages, looking at GitHub) go to scout, which has web_search and web_fetch',
                '- Before writing git steps (commit, branch, diff and the like), check with bash that the project is a git repository (`git rev-parse --is-inside-work-tree`); if it is not, leave such steps out and say so in your closing note',
                '- Put a human gate (gate) before actions such as pushing, publishing or deleting',
                '- Do not write keys, tokens or absolute paths of this machine into it',
                '',
                'When it is written, check it with workflow_check and fix every problem until it passes. Finally say in a sentence or two what it does, which inputs it needs and how to run it.',
            ].join('\n'),
        skillPrompt: (target) =>
            [
                'Turn the approach used in the thread below into a skill, so that similar tasks can follow it directly from now on.',
                '',
                'First read extension-creator with the skill tool, then write the skill in the format described there:',
                `- File: ${target}; the folder name matches the name`,
                '- The description says clearly when to use it (the tasks and keywords that come up)',
                '- The body holds reusable steps, commands and caveats, without the details of this one task; long reference material goes into other files in the same folder',
                '- Do not write keys, tokens or absolute paths of this machine into it',
                '',
                'When it is written, say in which situations it will be used.',
            ].join('\n'),
        draftTitle: (request) => `New workflow: ${request}`,
        draftPrompt: (target) =>
            [
                'In <request> below, the user describes a process to run again and again. Write it as a workflow.',
                '',
                'First read extension-creator with the skill tool, then draft the workflow in the format of its "Workflows" section:',
                `- File: ${target}; the name uses lower-case letters, digits and -, and the file name matches the name`,
                '- What changes from one run to the next (the problem description, files, branches and so on) becomes inputs',
                '- Give every step to a fitting agent (scout explores, coder codes, tester tests, debugger fixes bugs, reviewer reviews, writer writes docs); add verify to steps a command can check',
                '- Steps that research on the web (searching, reading pages, looking at GitHub) go to scout, which has web_search and web_fetch',
                '- Before writing git steps (commit, branch, diff and the like), check with bash that the project is a git repository (`git rev-parse --is-inside-work-tree`); if it is not, leave such steps out and say so in your closing note',
                '- Put a human gate (gate) before actions such as pushing, publishing or deleting',
                '- Do not write keys, tokens or absolute paths of this machine into it',
                '- Ask the user only when something essential is missing; settle the rest the way that makes sense',
                '',
                'When it is written, check it with workflow_check and fix every problem until it passes. Finally say in a sentence or two what it does and which inputs it needs, and tell the user the file is ready to run from the workflow board.',
            ].join('\n'),
    },
);

export interface DistillDeps {
    readonly threads: ThreadStore;
    readonly turns: TurnService;
    readonly projects: ProjectService;
    readonly settings: SettingsService;
    readonly log: Logger;
    /** `<data>/workflows` and `<data>/extensions`, for user-level results. */
    readonly workflowsDir: string;
    readonly extensionsDir: string;
    /** The gist of the request as the draft's title (06 §28). */
    readonly titles?: TitleService;
}

function clip(text: string, limit: number): string {
    const trimmed = text.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** The thread as text: requests, answers, tool calls with their commands, changed files; long middles dropped. */
export function transcript(threads: ThreadStore, threadId: string): string {
    const words = textOf(TEXT);
    const parts: string[] = [];
    for (const envelope of threads.events(threadId)) {
        const event = parseThreadEvent(envelope);
        if (!event) continue;
        if (event.kind === 'turn.started') {
            parts.push(
                `${words.user}\n${clip(event.payload.input.text, parts.length === 0 ? FIRST_LIMIT : MESSAGE_LIMIT)}`,
            );
        } else if (event.kind === 'item.completed') {
            const { item } = event.payload;
            if (item.type === 'agent_message' && item.text.trim()) {
                parts.push(`${words.agent}\n${clip(item.text, MESSAGE_LIMIT)}`);
            } else if (item.type === 'tool_call') {
                const input = item.input as { command?: unknown } | undefined;
                const command = typeof input?.command === 'string' ? clip(input.command, 300) : undefined;
                parts.push(words.tool(item.name ?? item.kind, item.status, clip(item.title, 200), command));
            }
        } else if (event.kind === 'turn.completed' && event.payload.changes) {
            const files = event.payload.changes.files.map((file) => file.path);
            if (files.length > 0) parts.push(words.changed(files.slice(0, 30)));
        } else if (event.kind === 'turn.failed') {
            parts.push(words.failed(clip(event.payload.error.message, 300)));
        }
    }
    const text = parts.join('\n\n');
    if (text.length <= TRANSCRIPT_LIMIT) return text;
    // Keep the first request and the end, where the thread got to.
    const head = parts[0] ?? '';
    return `${head}\n\n${words.omitted}\n\n${text.slice(-(TRANSCRIPT_LIMIT - head.length - 20))}`;
}

const CHECK_TOOL: HostToolProvider['tools'][number] = {
    name: 'workflow_check',
    description:
        'Check a workflow file you wrote: parses it and reports every problem with its path (or OK with the steps). ' +
        'Pass the path you wrote.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
    },
    kind: 'read',
};

export class DistillService {
    readonly #deps: DistillDeps;

    constructor(deps: DistillDeps) {
        this.#deps = deps;
    }

    async start(input: { threadId: string; kind: DistillKind; scope: 'project' | 'user' }): Promise<ThreadMeta> {
        const { threads, turns, log } = this.#deps;
        const words = textOf(TEXT);
        const source = threads.get(input.threadId);
        const project = await this.#project(source.projectId);
        const text = transcript(threads, source.id);
        if (!text.trim()) {
            throw new RpcError(RpcErrorCode.Rejected, words.empty);
        }
        const target = this.#target(input.kind, input.scope);
        const thread = threads.create({
            projectId: project.id,
            title: words.title(input.kind, clip(source.title, 20)),
            engine: 'xora',
            model: source.model,
            mode: this.#mode(project),
            effort: source.effort,
            ...(input.kind === 'workflow' ? { extra: { role: DISTILL_ROLE } } : {}),
        });
        if (input.kind === 'workflow') {
            turns.setHostTools(thread.id, this.#checkTool(project.path));
        }
        const prompt = input.kind === 'workflow' ? words.workflowPrompt(target) : words.skillPrompt(target);
        const started = await this.#open(
            thread,
            `${prompt}\n\n<thread_transcript title="${source.title.replaceAll('"', "'")}">\n${text}\n</thread_transcript>`,
        );
        log.info(`distill ${input.kind} from ${source.id} in ${thread.id}`);
        return started;
    }

    /**
     * A thread whose agent writes a new workflow from what the user describes (`workflow.draft`): distilling into a
     * workflow with the user's request in place of a thread's transcript.
     */
    async draft(input: { projectId: string; description: string; scope: 'project' | 'user' }): Promise<ThreadMeta> {
        const { threads, turns, settings, log } = this.#deps;
        const words = textOf(TEXT);
        const project = await this.#project(input.projectId);
        const description = input.description.trim();
        if (!description) {
            throw new RpcError(RpcErrorCode.InvalidParams, words.noDescription);
        }
        // The model and effort a new thread of the user's gets.
        const current = settings.get();
        const thread = threads.create({
            projectId: project.id,
            title: words.draftTitle(clip(description.replace(/\s+/g, ' '), 20)),
            engine: 'xora',
            model: project.defaults?.model ?? current.defaultModel,
            mode: this.#mode(project),
            effort: current.defaultEffort,
            extra: { role: DISTILL_ROLE },
        });
        turns.setHostTools(thread.id, this.#checkTool(project.path));
        const prompt = words.draftPrompt(this.#target('workflow', input.scope));
        const started = await this.#open(thread, `${prompt}\n\n<request>\n${description}\n</request>`);
        this.#deps.titles?.retitle(thread.id, description, (gist) => words.draftTitle(gist));
        log.info(`draft workflow in ${thread.id}`);
        return started;
    }

    async #project(projectId: string): Promise<Project> {
        const project = await this.#deps.projects.get(projectId);
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).projectMissing(project.path));
        }
        return project;
    }

    /**
     * The mode a thread the user opens gets, not a fixed one: in ask mode they review the file in an approval card
     * before it exists; in auto edit or full mode the agent writes it into the project without asking.
     */
    #mode(project: Project): PermissionMode {
        return project.defaults?.mode ?? this.#deps.settings.get().defaultMode;
    }

    /** The file the agent writes, as the prompt names it. */
    #target(kind: DistillKind, scope: 'project' | 'user'): string {
        const words = textOf(TEXT);
        if (kind === 'workflow') {
            return scope === 'project'
                ? words.inProject(`${path.join('.xora', 'workflows')}${path.sep}<name>.yaml`)
                : path.join(this.#deps.workflowsDir, '<name>.yaml');
        }
        return scope === 'project'
            ? words.inProject(`${path.join('.xora', 'skills', '<name>')}${path.sep}SKILL.md`)
            : path.join(this.#deps.extensionsDir, 'skills', '<name>', 'SKILL.md');
    }

    /** Starts the writing turn; a thread that cannot start (no model, a spent budget) does not stay behind empty. */
    async #open(thread: ThreadMeta, prompt: string): Promise<ThreadMeta> {
        const { threads, turns } = this.#deps;
        try {
            await turns.start(thread.id, prompt);
        } catch (error) {
            turns.setHostTools(thread.id, undefined);
            threads.delete(thread.id);
            throw error;
        }
        return threads.get(thread.id);
    }

    /** Host tools live in memory: a restart gives the open distill threads their check tool back. */
    async restore(): Promise<void> {
        for (const thread of this.#deps.threads.list({ includeArchived: false })) {
            if (thread.role !== DISTILL_ROLE) continue;
            const project = await this.#deps.projects.get(thread.projectId).catch(() => undefined);
            if (project && !project.missing) {
                this.#deps.turns.setHostTools(thread.id, this.#checkTool(project.path));
            }
        }
    }

    #checkTool(projectRoot: string): HostToolProvider {
        const roots = [path.join(projectRoot, '.xora', 'workflows'), this.#deps.workflowsDir];
        return {
            tools: [CHECK_TOOL],
            handle: async (_name, input) => {
                const given = (input as { path?: unknown } | null)?.path;
                if (typeof given !== 'string' || !given.trim()) {
                    return { content: '`path` is required.', isError: true };
                }
                const file = path.resolve(projectRoot, given);
                if (!/\.ya?ml$/i.test(file) || !roots.some((root) => file.startsWith(root + path.sep))) {
                    return {
                        content: `Only workflow files can be checked: ${roots.map((root) => `${root}${path.sep}*.yaml`).join(' or ')}`,
                        isError: true,
                    };
                }
                let text: string;
                try {
                    text = await readFile(file, 'utf8');
                } catch {
                    return { content: `Cannot read ${file}; write it first.`, isError: true };
                }
                const parsed = parseWorkflow(text);
                if (!parsed.ok) {
                    return {
                        content: parsed.issues
                            .map(
                                (issue) =>
                                    `- ${issue.line !== undefined ? `line ${issue.line}: ` : ''}${issuePath(issue.path) || '(file)'}: ${issue.message}`,
                            )
                            .join('\n'),
                        isError: true,
                    };
                }
                const name = path.basename(file).replace(/\.ya?ml$/i, '');
                const note =
                    name === parsed.definition.name ? '' : ` (rename the file to ${parsed.definition.name}.yaml)`;
                return {
                    content: `OK${note}: ${parsed.definition.steps.map((step) => `${step.id}(${step.type})`).join(' → ')}`,
                };
            },
        };
    }
}
