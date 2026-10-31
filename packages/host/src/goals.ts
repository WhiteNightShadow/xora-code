import { spawn } from 'node:child_process';
import type { Goal, ThreadMeta } from '@xora/protocol';
import { bilingual, RpcError, RpcErrorCode } from '@xora/protocol';
import { sanitizeEnv } from '@xora/tools';
import type { Logger } from './log.ts';
import type { ProjectService } from './projects.ts';
import { textOf } from './text.ts';
import type { ThreadStore } from './threads.ts';
import type { TurnEnded, TurnService } from './turns.ts';

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 12_000;
const DONE_MARKER = /^\s*GOAL:\s*DONE\s*$/im;

const TEXT = bilingual(
    {
        running: '线程正在运行，先停止再设定目标',
        checkCommand: (command: string) => `验收方式：每轮结束后我会运行\`${command}\`，退出码为0才算完成。`,
        checkMarker: '验收方式：你确认目标已经完成时，在回复最后单独一行写`GOAL: DONE`；还没完成就不要写。',
        first: (objective: string, check: string) =>
            `目标：${objective}\n\n${check}\n先弄清现状并列出计划（用todo工具），然后逐步完成。每一轮结束前说明做了什么、还差什么。`,
        checkFailed: (exitCode: number | null, output: string) =>
            `验收没有通过（退出码${exitCode ?? '无'}）。输出：\n\`\`\`\n${output || '（无输出）'}\n\`\`\``,
        notConfirmed: '你还没有确认目标完成。',
        retry: (failure: string, objective: string, round: number, maxRounds: number) =>
            `${failure}\n\n继续推进目标：${objective}\n这是第${round}轮，最多${maxRounds}轮。`,
    },
    {
        running: 'The thread is running; stop it before setting a goal',
        checkCommand: (command) =>
            `Acceptance: after every round I run \`${command}\`; the goal is done only when it exits with code 0.`,
        checkMarker:
            'Acceptance: once you are sure the goal is done, write `GOAL: DONE` alone on the last line of your reply; do not write it before then.',
        first: (objective, check) =>
            `Goal: ${objective}\n\n${check}\nFirst find out where things stand and list a plan (with the todo tool), then work through it step by step. Before each round ends, say what you did and what is left.`,
        checkFailed: (exitCode, output) =>
            `The acceptance check failed (exit code ${exitCode ?? 'none'}). Output:\n\`\`\`\n${output || '(no output)'}\n\`\`\``,
        notConfirmed: 'You have not confirmed that the goal is done yet.',
        retry: (failure, objective, round, maxRounds) =>
            `${failure}\n\nKeep working on the goal: ${objective}\nThis is round ${round} of at most ${maxRounds}.`,
    },
);

export interface CheckResult {
    readonly passed: boolean;
    readonly exitCode: number | null;
    readonly output: string;
}

/** Runs the acceptance command in the thread's working directory, without the user's secrets in the env. */
export function runCheck(
    command: string,
    cwd: string,
    signal?: AbortSignal,
    timeoutMs = CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
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
        const timer = setTimeout(kill, timeoutMs);
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
    const text = textOf(TEXT);
    const check = goal.acceptCommand ? text.checkCommand(goal.acceptCommand) : text.checkMarker;
    return text.first(goal.objective, check);
}

function retryPrompt(goal: Goal, check: CheckResult | undefined): string {
    const text = textOf(TEXT);
    const failure = check ? text.checkFailed(check.exitCode, check.output.trim()) : text.notConfirmed;
    return text.retry(failure, goal.objective, goal.rounds + 1, goal.maxRounds);
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
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).running);
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
