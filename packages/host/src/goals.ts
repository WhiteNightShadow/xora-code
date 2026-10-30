import { spawn } from 'node:child_process';
import type { Goal, ThreadMeta } from '@xora/protocol';
import { RpcError, RpcErrorCode } from '@xora/protocol';
import { sanitizeEnv } from '@xora/tools';
import type { Logger } from './log.ts';
import type { ProjectService } from './projects.ts';
import type { ThreadStore } from './threads.ts';
import type { TurnEnded, TurnService } from './turns.ts';

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 12_000;
const DONE_MARKER = /^\s*GOAL:\s*DONE\s*$/im;

export interface CheckResult {
    readonly passed: boolean;
    readonly exitCode: number | null;
    readonly output: string;
}

/** Runs the acceptance command in the thread's working directory, without the user's secrets in the env. */
export function runCheck(command: string, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
    return new Promise((resolve) => {
        const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
        const args =
            process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
        const child = spawn(shell, args, {
            cwd,
            env: sanitizeEnv(process.env) as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
        let output = '';
        const append = (chunk: Buffer) => {
            output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT * 2);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const kill = () => {
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch {
                // already gone
            }
        };
        const timer = setTimeout(kill, CHECK_TIMEOUT_MS);
        signal?.addEventListener('abort', kill, { once: true });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ passed: false, exitCode: null, output: error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const tail = output.length > OUTPUT_LIMIT ? `…\n${output.slice(-OUTPUT_LIMIT)}` : output;
            resolve({ passed: code === 0, exitCode: code, output: tail });
        });
    });
}

function firstPrompt(goal: Goal): string {
    const check = goal.acceptCommand
        ? `验收方式：每轮结束后我会运行\`${goal.acceptCommand}\`，退出码为0才算完成。`
        : '验收方式：你确认目标已经完成时，在回复最后单独一行写`GOAL: DONE`；还没完成就不要写。';
    return `目标：${goal.objective}\n\n${check}\n先弄清现状并列出计划（用todo工具），然后逐步完成。每一轮结束前说明做了什么、还差什么。`;
}

function retryPrompt(goal: Goal, check: CheckResult | undefined): string {
    const failure = check
        ? `验收没有通过（退出码${check.exitCode ?? '无'}）。输出：\n\`\`\`\n${check.output.trim() || '（无输出）'}\n\`\`\``
        : '你还没有确认目标完成。';
    return `${failure}\n\n继续推进目标：${goal.objective}\n这是第${goal.rounds + 1}轮，最多${goal.maxRounds}轮。`;
}

/**
 * Goal mode (04 §6): keep turning until the acceptance check passes, the rounds run out or the budget is spent.
 * With an acceptance command the command decides; without one, the agent has to say `GOAL: DONE`.
 */
export class GoalService {
    readonly #threads: ThreadStore;
    readonly #projects: ProjectService;
    readonly #turns: () => TurnService;
    readonly #log: Logger;

    constructor(options: { threads: ThreadStore; projects: ProjectService; turns: () => TurnService; log: Logger }) {
        this.#threads = options.threads;
        this.#projects = options.projects;
        this.#turns = options.turns;
        this.#log = options.log;
    }

    #set(thread: ThreadMeta, goal: Goal): ThreadMeta {
        const updated = this.#threads.update(thread.id, { goal }, { touch: false });
        this.#threads.append(thread.id, 'goal.updated', { goal });
        return updated;
    }

    async start(
        threadId: string,
        input: { objective: string; acceptCommand?: string; maxRounds?: number; budget?: number },
    ): Promise<ThreadMeta> {
        const thread = this.#threads.get(threadId);
        if (this.#turns().isRunning(threadId)) {
            throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再设定目标');
        }
        const goal: Goal = {
            objective: input.objective.trim(),
            ...(input.acceptCommand?.trim() ? { acceptCommand: input.acceptCommand.trim() } : {}),
            maxRounds: input.maxRounds ?? 8,
            ...(input.budget !== undefined ? { budget: input.budget } : {}),
            state: 'active',
            rounds: 0,
        };
        const updated = this.#set(thread, goal);
        await this.#turns().start(threadId, firstPrompt(goal), []);
        return updated;
    }

    stop(threadId: string): ThreadMeta {
        const thread = this.#threads.get(threadId);
        if (thread.goal?.state !== 'active') {
            return thread;
        }
        return this.#set(thread, { ...thread.goal, state: 'stopped' });
    }

    /** Turn hook: check, then finish the goal or start the next round. */
    async onTurnEnded(event: TurnEnded): Promise<void> {
        const thread = this.#threads.find(event.threadId);
        const goal = thread?.goal;
        if (!thread || !goal || goal.state !== 'active') {
            return;
        }
        if (event.outcome === 'cancelled') {
            this.#set(thread, { ...goal, state: 'stopped' });
            return;
        }
        if (event.outcome === 'failed') {
            this.#set(thread, { ...goal, state: 'failed' });
            return;
        }
        const rounds = goal.rounds + 1;
        let check: CheckResult | undefined;
        let passed: boolean;
        if (goal.acceptCommand) {
            const project = await this.#projects.get(thread.projectId);
            check = await runCheck(goal.acceptCommand, this.#turns().cwdOf(thread, project));
            passed = check.passed;
        } else {
            passed = DONE_MARKER.test(event.lastText);
        }
        const current = this.#threads.get(thread.id);
        if (current.goal?.state !== 'active') {
            return;
        }
        const next: Goal = { ...current.goal, rounds, ...(check ? { lastCheck: check } : {}) };
        if (passed) {
            this.#set(current, { ...next, state: 'achieved' });
            return;
        }
        const spent = current.cost?.amount ?? 0;
        if (rounds >= next.maxRounds || (next.budget !== undefined && spent >= next.budget)) {
            this.#set(current, { ...next, state: 'exhausted' });
            return;
        }
        this.#set(current, next);
        try {
            await this.#turns().start(thread.id, retryPrompt(next, check), []);
        } catch (error) {
            this.#log.warn(`goal round failed to start: ${error instanceof Error ? error.message : String(error)}`);
            this.#set(this.#threads.get(thread.id), { ...next, state: 'failed' });
        }
    }
}
