import type { Item, MemoryCandidate, ThreadEventPayload } from '@xora/protocol';
import { completeModel, findModel } from '@xora/providers';
import type { Bus } from '../bus.ts';
import type { ConnectionService } from '../connections.ts';
import { newId } from '../ids.ts';
import { type Logger, redact } from '../log.ts';
import type { SettingsService } from '../settings.ts';
import { hostLanguage } from '../text.ts';
import type { ThreadStore } from '../threads.ts';
import type { TurnEnded } from '../turns.ts';
import type { UsageService } from '../usage.ts';
import { REMEMBER_TOOL } from './notes.ts';
import { type MemoryService, sharesMemory } from './service.ts';

const SYSTEM = (zh: boolean) =>
    zh
        ? [
              '你负责从一次“踩坑后修复成功”的开发回合中，提炼值得跨会话复用的项目事实或踩坑经验。',
              '只保留后续会话仍然适用的稳定规律（例如：构建/测试命令的必要参数、工具链/环境变量要求、目录或架构约束）。',
              '如果是偶然拼写错误、一次性路径写错或临时网络抖动，必须返回空数组。',
              '只输出严格 JSON，格式：{"candidates":[{"kind":"deadend"|"fact"|"constraint","scope":"project"|"user","note":"一句话结论（<=120字，不含密钥）"}]}，最多 2 条。',
          ].join('\n')
        : [
              'Distill reusable project notes from a coding turn that hit a tool failure and then recovered.',
              'Keep ONLY durable project facts, pitfalls, or constraints that future sessions should know (e.g. required build/test flags, toolchain quirks, architectural invariants).',
              'Return an empty array for one-off typos, wrong paths, or transient network hiccups.',
              'Reply with strict JSON only: {"candidates":[{"kind":"deadend"|"fact"|"constraint","scope":"project"|"user","note":"one concise sentence (<=200 chars, no secrets)"}]}, at most 2 items.',
          ].join('\n');

export interface MemoryExtractorDeps {
    readonly threads: ThreadStore;
    readonly memory: Pick<MemoryService, 'filterCandidates'>;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly usage: UsageService;
    readonly bus: Bus;
    readonly log: Logger;
    readonly userAgent?: string;
}

function toolFailureSnippet(item: Extract<Item, { type: 'tool_call' }>): string {
    const raw =
        item.output ??
        (item.display?.kind === 'command'
            ? item.display.output
            : item.display?.kind === 'text'
              ? item.display.text
              : '');
    return redact(raw.replace(/\s+/g, ' ').trim()).slice(0, 360);
}

export function parseExtractedCandidates(answer: string): Array<Record<string, unknown>> {
    const trimmed = answer
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { candidates?: unknown };
        if (!Array.isArray(parsed.candidates)) return [];
        return parsed.candidates
            .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
            .map((entry, index) => ({
                id: `mc_${newId('m')}_${index + 1}`,
                ...entry,
            }));
    } catch {
        return [];
    }
}

export class MemoryExtractor {
    readonly #deps: MemoryExtractorDeps;
    readonly #pending = new Set<Promise<void>>();
    #disposed = false;

    constructor(deps: MemoryExtractorDeps) {
        this.#deps = deps;
    }

    onTurnEnded(event: TurnEnded): void {
        if (this.#disposed || event.outcome !== 'completed' || !event.lastText.trim()) return;
        const job = this.#extract(event)
            .catch((error: unknown) => {
                this.#deps.log.info(
                    `memory extract for ${event.threadId}/${event.turnId} skipped: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            })
            .finally(() => {
                this.#pending.delete(job);
            });
        this.#pending.add(job);
    }

    async flush(): Promise<void> {
        this.#disposed = true;
        await Promise.allSettled([...this.#pending]);
    }

    async #extract(event: TurnEnded): Promise<void> {
        const { threads, memory, connections, settings, usage, bus } = this.#deps;
        const thread = threads.find(event.threadId);
        if (!thread || !sharesMemory(thread) || !thread.projectId || thread.role === 'chief') return;

        const events = threads.events(event.threadId);
        let userText = '';
        const failedTools: Array<Extract<Item, { type: 'tool_call' }>> = [];
        const succeededAfterFail: string[] = [];
        for (const entry of events) {
            if (entry.turnId !== event.turnId) continue;
            if (entry.kind === 'turn.started') {
                const started = entry.payload as ThreadEventPayload<'turn.started'>;
                if (started.input.type === 'user_message') userText = started.input.text;
                continue;
            }
            if (entry.kind !== 'item.completed') continue;
            const { item } = entry.payload as ThreadEventPayload<'item.completed'>;
            if (item.type === 'compaction' && (item.candidates?.length ?? 0) > 0) {
                return;
            }
            if (item.type !== 'tool_call') continue;
            if (item.name === REMEMBER_TOOL) return;
            if (item.status === 'failed') {
                failedTools.push(item);
            } else if (item.status === 'completed' && failedTools.length > 0) {
                succeededAfterFail.push(item.title);
            }
        }
        if (failedTools.length === 0 || (succeededAfterFail.length === 0 && event.changedFiles.length === 0)) {
            return;
        }

        const current = settings.get();
        const ref = current.fastModel ?? thread.model ?? current.defaultModel;
        if (!ref) return;

        const digest = [
            `User request: ${redact(userText).slice(0, 600)}`,
            'Failed tool calls:',
            ...failedTools.slice(0, 4).map((tool) => {
                const snippet = toolFailureSnippet(tool);
                return `- ${redact(tool.title).slice(0, 140)}${snippet ? ` -> ${snippet}` : ''}`;
            }),
            ...(succeededAfterFail.length > 0
                ? [
                      'Subsequent succeeded steps:',
                      ...succeededAfterFail.slice(0, 4).map((title) => `- ${redact(title).slice(0, 140)}`),
                  ]
                : []),
            `Final resolution: ${redact(event.lastText).slice(0, 1_000)}`,
        ].join('\n');

        const connection = await connections.providerConnection(ref.connectionId);
        if (this.#disposed) return;
        const zh = hostLanguage() === 'zh-CN';
        const done = await completeModel(
            connection,
            {
                model: ref.model,
                system: [SYSTEM(zh)],
                messages: [{ role: 'user', content: [{ type: 'text', text: digest }] }],
                effort: 'off',
                maxOutputTokens: 300,
            },
            { userAgent: this.#deps.userAgent ?? 'XoraCode', signal: AbortSignal.timeout(25_000) },
        );
        if (this.#disposed) return;
        const pricing = findModel(connection, ref.model).pricing;
        const recorded = usage.record({
            projectId: thread.projectId,
            threadId: thread.id,
            turnId: event.turnId,
            agentPath: 'memory',
            engine: 'xora',
            provider: connection.preset.id,
            channel: connection.preset.channel,
            model: ref.model,
            ...(pricing ? { pricing } : {}),
            usage: done.usage ?? null,
            latencyMs: done.latencyMs,
            ...(done.ttftMs !== undefined ? { ttftMs: done.ttftMs } : {}),
            stopReason: done.stopReason,
            status: 'ok',
            source: done.usage ? 'vendor' : 'estimate',
        });
        if (recorded.cost) bus.broadcast('usage.changed', { threadId: thread.id, cost: recorded.cost });

        const answer = done.message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')
            .trim();
        const latest = threads.find(event.threadId);
        if (!latest || this.#disposed) return;
        const candidates: MemoryCandidate[] = memory.filterCandidates(latest, parseExtractedCandidates(answer));
        if (candidates.length === 0) return;

        const notice: Item = {
            id: newId('i'),
            turnId: event.turnId,
            ts: Date.now(),
            type: 'notice',
            severity: 'info',
            title: zh ? '提炼出可复用的项目经验' : 'Reusable project notes distilled',
            candidates,
        };
        threads.append(event.threadId, 'item.completed', { item: notice }, { turnId: event.turnId, itemId: notice.id });
    }
}
