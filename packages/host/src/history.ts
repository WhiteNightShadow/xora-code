import { type RevertResult, RpcError, RpcErrorCode, type ThreadMeta } from '@xora/protocol';
import type { EngineManager } from './engines/manager.ts';
import { engineById } from './engines/registry.ts';
import type { Logger } from './log.ts';
import type { ProjectService } from './projects.ts';
import type { ReviewService } from './review.ts';
import type { ThreadStore } from './threads.ts';
import type { TurnService } from './turns.ts';

/** JSON-RPC "invalid params": the engine does not know the turn (it never reached the engine). */
const UNKNOWN_TURN = -32602;

export interface HistoryDeps {
    readonly threads: ThreadStore;
    readonly projects: ProjectService;
    readonly review: ReviewService;
    readonly engines: EngineManager;
    readonly turns: TurnService;
    readonly log: Logger;
    /** Creates a thread the same way `thread.create` does (worktree included). */
    readonly createThread: (params: {
        projectId: string;
        title: string;
        model?: { connectionId: string; model: string };
        mode: ThreadMeta['mode'];
        effort: ThreadMeta['effort'];
        sessionPrompt?: string;
        location: 'local' | 'worktree';
        engine: string;
    }) => Promise<ThreadMeta>;
}

function isUnknownTurn(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === UNKNOWN_TURN;
}

/**
 * Going back to before a turn and forking a thread from a turn (M3-3). The xora engine keeps a marker at the
 * start of every host turn; rewinding appends a record and never deletes history, and the timeline keeps the
 * rewound turns, marked.
 */
export class HistoryService {
    readonly #deps: HistoryDeps;

    constructor(deps: HistoryDeps) {
        this.#deps = deps;
    }

    /** Turns of the thread that are still part of the conversation, in order. */
    liveTurns(threadId: string): string[] {
        const turns: string[] = [];
        for (const event of this.#deps.threads.events(threadId)) {
            if (event.kind === 'turn.started' && event.turnId) {
                turns.push(event.turnId);
            } else if (event.kind === 'thread.rewound' && event.turnId) {
                const at = turns.indexOf(event.turnId);
                if (at >= 0) turns.length = at;
            }
        }
        return turns;
    }

    #xoraThread(threadId: string): { thread: ThreadMeta; engine: NonNullable<ReturnType<typeof engineById>> } {
        const thread = this.#deps.threads.get(threadId);
        const engine = engineById(thread.engine);
        if (engine?.kind !== 'builtin') {
            throw new RpcError(
                RpcErrorCode.Rejected,
                '外部引擎的线程不能回退或分叉对话；要恢复文件可以用每一轮的“撤销这一轮”',
            );
        }
        if (this.#deps.turns.isRunning(threadId)) {
            throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再操作');
        }
        return { thread, engine };
    }

    async rewind(threadId: string, turnId: string, files: boolean, force = false): Promise<RevertResult> {
        const { threads, projects, review, engines, turns } = this.#deps;
        const { thread, engine } = this.#xoraThread(threadId);
        const live = this.liveTurns(threadId);
        const index = live.indexOf(turnId);
        if (index < 0) {
            throw new RpcError(RpcErrorCode.NotFound, '找不到这一轮，或者它已经回退过了');
        }
        const later = live.slice(index);

        // The conversation first: when it cannot go back, nothing changes.
        const sessionId = threads.sessionId(threadId);
        if (sessionId) {
            const process = await engines.connect(engine, thread.projectId);
            // A turn that failed before reaching the engine has no marker; the next one that did marks the same point.
            for (const candidate of later) {
                try {
                    await process.agent.request('_xora/session/rewind', { sessionId, turnId: candidate });
                    break;
                } catch (error) {
                    if (!isUnknownTurn(error)) throw error;
                }
            }
        }

        const result: RevertResult = { restored: [], deleted: [], conflicts: [] };
        if (files) {
            const project = await projects.get(thread.projectId);
            const cwd = turns.cwdOf(thread, project);
            // Newest first, so every turn is undone on top of the state it left behind.
            for (const id of [...later].reverse()) {
                const turn = threads.turn(threadId, id);
                if (!turn?.before || !turn.after) continue;
                const targets = (await review.changes(cwd, turn.before, turn.after)).flatMap((change) =>
                    change.oldPath ? [change.path, change.oldPath] : [change.path],
                );
                if (targets.length === 0) continue;
                const reverted = await review.revert(cwd, turn.before, turn.after, targets, force);
                result.restored.push(...reverted.restored.filter((file) => !result.restored.includes(file)));
                result.deleted.push(...reverted.deleted.filter((file) => !result.deleted.includes(file)));
                result.conflicts.push(...reverted.conflicts);
            }
        }
        threads.append(
            threadId,
            'thread.rewound',
            { turnId, files, paths: [...result.restored, ...result.deleted], conflicts: result.conflicts },
            { turnId },
        );
        return result;
    }

    async fork(threadId: string, afterTurnId?: string): Promise<ThreadMeta> {
        const { threads, engines } = this.#deps;
        const { thread, engine } = this.#xoraThread(threadId);
        const live = this.liveTurns(threadId);
        let keep = live;
        if (afterTurnId !== undefined) {
            const index = live.indexOf(afterTurnId);
            if (index < 0) {
                throw new RpcError(RpcErrorCode.NotFound, '找不到这一轮，或者它已经回退过了');
            }
            keep = live.slice(0, index + 1);
        }
        const dropped = live.slice(keep.length);

        let forkedSession: string | undefined;
        const sessionId = threads.sessionId(threadId);
        if (sessionId) {
            const process = await engines.connect(engine, thread.projectId);
            // Fork before the first dropped turn the engine knows; when it knows none of them, take everything.
            for (const candidate of [...dropped, undefined]) {
                try {
                    const forked = await process.agent.request<{ sessionId: string }>('_xora/session/fork', {
                        sessionId,
                        ...(candidate ? { beforeTurnId: candidate } : {}),
                    });
                    forkedSession = forked.sessionId;
                    break;
                } catch (error) {
                    if (!isUnknownTurn(error) || candidate === undefined) throw error;
                }
            }
        }

        const sessionPrompt = threads.sessionPrompt(threadId);
        const created = await this.#deps.createThread({
            projectId: thread.projectId,
            title: `${thread.title}（分叉）`,
            ...(thread.model ? { model: thread.model } : {}),
            mode: thread.mode,
            effort: thread.effort,
            ...(sessionPrompt ? { sessionPrompt } : {}),
            location: thread.location.kind === 'worktree' ? 'worktree' : 'local',
            engine: thread.engine,
        });
        const kept = new Set(keep);
        if (thread.location.kind === 'local') {
            // Same folder: the checkpoints still describe these turns.
            for (const id of keep) {
                threads.copyTurn(threadId, created.id, id);
            }
        }
        for (const event of threads.events(threadId)) {
            if (event.turnId && kept.has(event.turnId) && event.kind !== 'thread.rewound') {
                threads.append(created.id, event.kind as never, event.payload as never, {
                    turnId: event.turnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                });
            }
        }
        const turnCount = keep.length;
        return threads.update(
            created.id,
            { ...(forkedSession ? { sessionId: forkedSession } : {}), turns: turnCount },
            { touch: false },
        );
    }
}
