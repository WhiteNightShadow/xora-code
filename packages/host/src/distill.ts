import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseThreadEvent, RpcError, RpcErrorCode, type ThreadMeta } from '@xora/protocol';
import { issuePath, parseWorkflow } from '@xora/workflows';
import type { Logger } from './log.ts';
import type { ProjectService } from './projects.ts';
import type { ThreadStore } from './threads.ts';
import type { HostToolProvider, TurnService } from './turns.ts';

/**
 * Distilling a finished thread into a workflow or a skill (06 §11, 15 §6): a new thread in the same project gets
 * the old one's transcript and the extension-creator skill's formats, and saves the file with the write tool, so
 * the user reviews it in an approval card. A workflow draft is checked with `workflow_check` until it parses.
 */

const TRANSCRIPT_LIMIT = 24_000;
const MESSAGE_LIMIT = 1_500;
const FIRST_LIMIT = 4_000;

export type DistillKind = 'workflow' | 'skill';

export interface DistillDeps {
    readonly threads: ThreadStore;
    readonly turns: TurnService;
    readonly projects: ProjectService;
    readonly log: Logger;
    /** `<data>/workflows` and `<data>/extensions`, for user-level results. */
    readonly workflowsDir: string;
    readonly extensionsDir: string;
}

function clip(text: string, limit: number): string {
    const trimmed = text.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** The thread as text: requests, answers, tool calls with their commands, changed files; long middles dropped. */
export function transcript(threads: ThreadStore, threadId: string): string {
    const parts: string[] = [];
    for (const envelope of threads.events(threadId)) {
        const event = parseThreadEvent(envelope);
        if (!event) continue;
        if (event.kind === 'turn.started') {
            parts.push(`## 用户\n${clip(event.payload.input.text, parts.length === 0 ? FIRST_LIMIT : MESSAGE_LIMIT)}`);
        } else if (event.kind === 'item.completed') {
            const { item } = event.payload;
            if (item.type === 'agent_message' && item.text.trim()) {
                parts.push(`## agent\n${clip(item.text, MESSAGE_LIMIT)}`);
            } else if (item.type === 'tool_call') {
                const input = item.input as { command?: unknown } | undefined;
                const command = typeof input?.command === 'string' ? `：\`${clip(input.command, 300)}\`` : '';
                parts.push(`- 工具${item.name ?? item.kind}（${item.status}）：${clip(item.title, 200)}${command}`);
            }
        } else if (event.kind === 'turn.completed' && event.payload.changes) {
            const files = event.payload.changes.files.map((file) => file.path);
            if (files.length > 0) parts.push(`- 改动的文件：${files.slice(0, 30).join('、')}`);
        } else if (event.kind === 'turn.failed') {
            parts.push(`- 这一轮失败：${clip(event.payload.error.message, 300)}`);
        }
    }
    const text = parts.join('\n\n');
    if (text.length <= TRANSCRIPT_LIMIT) return text;
    // Keep the first request and the end, where the thread got to.
    const head = parts[0] ?? '';
    return `${head}\n\n…（中间省略）…\n\n${text.slice(-(TRANSCRIPT_LIMIT - head.length - 20))}`;
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
        const { threads, turns, projects, log } = this.#deps;
        const source = threads.get(input.threadId);
        const project = await projects.get(source.projectId);
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, `项目文件夹不存在：${project.path}`);
        }
        const text = transcript(threads, source.id);
        if (!text.trim()) {
            throw new RpcError(RpcErrorCode.Rejected, '这个线程还没有内容');
        }
        const target =
            input.kind === 'workflow'
                ? input.scope === 'project'
                    ? `${path.join('.xora', 'workflows')}${path.sep}<name>.yaml（项目根目录下）`
                    : path.join(this.#deps.workflowsDir, '<name>.yaml')
                : input.scope === 'project'
                  ? `${path.join('.xora', 'skills', '<name>')}${path.sep}SKILL.md（项目根目录下）`
                  : path.join(this.#deps.extensionsDir, 'skills', '<name>', 'SKILL.md');
        const thread = threads.create({
            projectId: project.id,
            title: `${input.kind === 'workflow' ? '沉淀工作流' : '沉淀skill'}：${clip(source.title, 20)}`,
            engine: 'xora',
            model: source.model,
            // Every file is written through an approval card: the user reviews the draft before it exists.
            mode: 'ask',
            effort: source.effort,
        });
        if (input.kind === 'workflow') {
            turns.setHostTools(thread.id, this.#checkTool(project.path));
        }
        const prompt = input.kind === 'workflow' ? workflowPrompt(target) : skillPrompt(target);
        await turns.start(
            thread.id,
            `${prompt}\n\n<thread_transcript title="${source.title.replaceAll('"', "'")}">\n${text}\n</thread_transcript>`,
        );
        log.info(`distill ${input.kind} from ${source.id} in ${thread.id}`);
        return threads.get(thread.id);
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

function workflowPrompt(target: string): string {
    return [
        '把下面这个线程里做成的事沉淀成一个可以反复运行的工作流。',
        '',
        '先用skill工具读extension-creator，按其中“Workflows”一节的格式起草：',
        `- 文件：${target}，name用小写字母、数字和-，文件名和name一致`,
        '- 线程里每次会变的东西（问题描述、文件、分支等）做成inputs',
        '- 每一步交给合适的agent（scout侦察、coder编码、tester测试、debugger修bug、reviewer审查、writer文档）；能用命令验收的步骤加verify',
        '- 推送、发布、删除这类动作前加人工关卡（gate）',
        '- 不要写进密钥、token和本机的绝对路径',
        '',
        '写好后调用workflow_check检查，有问题就改，直到通过。最后用一两句话说明它做什么、需要哪些输入、怎么运行。',
    ].join('\n');
}

function skillPrompt(target: string): string {
    return [
        '把下面这个线程里用到的做法沉淀成一个skill，以后遇到同类任务时能直接照着做。',
        '',
        '先用skill工具读extension-creator，按其中skill的格式写：',
        `- 文件：${target}，文件夹名和name一致`,
        '- description写清楚什么时候该用它（会出现的任务和关键词）',
        '- 正文写可复用的步骤、命令和注意事项，去掉这次任务特有的细节；长的参考资料放到同一文件夹的其他文件里',
        '- 不要写进密钥、token和本机的绝对路径',
        '',
        '写好后说明它会在什么情况下被用到。',
    ].join('\n');
}
