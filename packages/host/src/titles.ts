import type { ModelRef } from '@xora/protocol';
import { completeModel, findModel } from '@xora/providers';
import type { Bus } from './bus.ts';
import type { ConnectionService } from './connections.ts';
import type { Logger } from './log.ts';
import type { SettingsService } from './settings.ts';
import { hostLanguage } from './text.ts';
import type { ThreadStore } from './threads.ts';
import type { UsageService } from './usage.ts';

/**
 * Titles that say what a conversation is about (06 §28): a new conversation, team run, workflow draft or talk with
 * a member gets the gist of its opening request as its title, written by the fast model (the thread's or the default
 * model when none is set). Until then, and when no model answers, it keeps the start of the request.
 */

const OPENING_CHARS = 2_000;

const SYSTEM = (zh: boolean) =>
    zh
        ? '给一段对话起标题：根据它开头的请求，用不超过14个汉字概括要做的事。不加引号、不加句号、不写“标题：”，只回答标题本身。英文词用小写。'
        : 'Write a title for a conversation from its opening request: the gist in at most 7 words. No quotes, no final full stop, no "Title:". Answer with the title only.';

export interface TitleDeps {
    readonly threads: ThreadStore;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly usage: UsageService;
    readonly bus: Bus;
    readonly log: Logger;
    readonly userAgent?: string;
}

/** The start of a request: its first line that has words, cut short. */
export function openingLine(text: string, length = 40): string {
    const line =
        text
            .split('\n')
            .find((candidate) => candidate.trim().length > 0)
            ?.trim() ?? '';
    return line.length > length ? `${line.slice(0, length)}…` : line;
}

/** A model's answer as a title: one line, no quotes, labels or final punctuation, not too long. */
export function cleanTitle(answer: string): string | undefined {
    const line = (answer.split('\n').find((candidate) => candidate.trim()) ?? '')
        .trim()
        .replace(/^(?:标题|title)\s*[:：]\s*/i, '')
        .replace(/^["'“”‘’「」『』《》`*#\s]+|["'“”‘’「」『』《》`*\s]+$/g, '')
        .replace(/[。.!！?？;；,，、:：]+$/u, '')
        .trim();
    if (!line) return undefined;
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export class TitleService {
    readonly #deps: TitleDeps;

    constructor(deps: TitleDeps) {
        this.#deps = deps;
    }

    /** The gist of a request as a title, or undefined when no model can write one. */
    async summarize(
        text: string,
        context: { readonly projectId: string; readonly threadId?: string; readonly model?: ModelRef | null },
    ): Promise<string | undefined> {
        const { connections, settings, usage, bus } = this.#deps;
        const current = settings.get();
        const ref = current.fastModel ?? context.model ?? current.defaultModel;
        if (!ref) return undefined;
        const connection = await connections.providerConnection(ref.connectionId);
        const done = await completeModel(
            connection,
            {
                model: ref.model,
                system: [SYSTEM(hostLanguage() === 'zh-CN')],
                messages: [{ role: 'user', content: [{ type: 'text', text: text.slice(0, OPENING_CHARS) }] }],
                effort: 'off',
                maxOutputTokens: 60,
            },
            { userAgent: this.#deps.userAgent ?? 'XoraCode', signal: AbortSignal.timeout(30_000) },
        );
        if (context.threadId) {
            const pricing = findModel(connection, ref.model).pricing;
            const recorded = usage.record({
                projectId: context.projectId,
                threadId: context.threadId,
                turnId: 'title',
                agentPath: 'title',
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
            if (recorded.cost) bus.broadcast('usage.changed', { threadId: context.threadId, cost: recorded.cost });
        }
        return cleanTitle(
            done.message.content
                .map((part) => (part.type === 'text' ? part.text : ''))
                .join('')
                .trim(),
        );
    }

    /**
     * Gives a thread the gist of its opening request as its title, formatted (`总助手：…`), in the background; a
     * title the user changed in the meantime stays.
     */
    retitle(threadId: string, text: string, format: (gist: string) => string = (gist) => gist): void {
        const { threads, log } = this.#deps;
        const thread = threads.find(threadId);
        if (!thread || !text.trim()) return;
        const before = thread.title;
        void this.summarize(text, { projectId: thread.projectId, threadId, model: thread.model })
            .then((gist) => {
                const now = threads.find(threadId);
                if (!gist || !now || now.title !== before) return;
                threads.update(threadId, { title: format(gist) }, { touch: false });
            })
            .catch((error: unknown) =>
                log.info(`title of ${threadId} kept: ${error instanceof Error ? error.message : String(error)}`),
            );
    }
}
