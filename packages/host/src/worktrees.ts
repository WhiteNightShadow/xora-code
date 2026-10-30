import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DiffFile, HandoffResult, Project } from '@xora/protocol';
import { RpcError, RpcErrorCode } from '@xora/protocol';
import {
    allocatePort,
    diffForReview,
    findGit,
    isGitRepo,
    readCursorWorktreesJson,
    releasePort,
    revertHunks,
    runGit,
    stageHunks,
    unstageHunks,
    WorktreeDirtyError,
    WorktreeLimitError,
    WorktreeManager,
} from '@xora/workspace';
import type { Logger } from './log.ts';
import type { ReviewService } from './review.ts';

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

function toHandoff(result: {
    status: 'moved' | 'conflicts' | 'failed';
    tracked: readonly string[];
    untracked: readonly string[];
    conflicts: ReadonlyArray<{ path: string; reason?: string; message?: string }>;
}): HandoffResult {
    return {
        status: result.status,
        tracked: [...result.tracked],
        untracked: [...result.untracked],
        conflicts: result.conflicts.map((conflict) => ({
            path: conflict.path,
            reason: conflict.reason ?? conflict.message ?? 'conflict',
        })),
    };
}

/** Setup commands from `.xora/worktree.json` (`{"setup": [...]}`) or, for compatibility, `.cursor/worktrees.json`. */
async function setupCommands(repoDir: string): Promise<string[]> {
    const own = path.join(repoDir, '.xora', 'worktree.json');
    if (existsSync(own)) {
        try {
            const parsed = JSON.parse(readFileSync(own, 'utf8')) as { setup?: unknown };
            if (Array.isArray(parsed.setup)) {
                return parsed.setup.filter((command): command is string => typeof command === 'string');
            }
        } catch {
            return [];
        }
    }
    return (await readCursorWorktreesJson(repoDir))?.setup ?? [];
}

/**
 * Worktree threads (04 §1): each gets a detached checkout under `<data>/worktrees/<projectId>/<threadId>`, its own
 * port (`XORA_PORT`) and the project's setup commands; work can be handed between the project folder and a
 * worktree, and a candidate's changes applied back to the project folder.
 */
export class WorktreeService {
    readonly #rootDir: string;
    readonly #log: Logger;
    readonly #review: ReviewService;

    constructor(options: { rootDir: string; log: Logger; review: ReviewService }) {
        this.#rootDir = options.rootDir;
        this.#log = options.log;
        this.#review = options.review;
    }

    #manager(project: Project): WorktreeManager {
        return new WorktreeManager({ repoDir: project.path, rootDir: path.join(this.#rootDir, project.id) });
    }

    async #requireRepo(project: Project): Promise<void> {
        if (!(await findGit())) {
            throw new RpcError(RpcErrorCode.Rejected, '没有找到git，无法使用worktree');
        }
        if (!(await isGitRepo(project.path))) {
            throw new RpcError(RpcErrorCode.Rejected, '项目不是git仓库，无法使用worktree');
        }
    }

    async create(project: Project, threadId: string): Promise<{ path: string; port: number }> {
        await this.#requireRepo(project);
        const manager = this.#manager(project);
        try {
            const created = await manager.create({ id: threadId });
            const port = await allocatePort(threadId);
            this.#log.info(`worktree for ${threadId} at ${created.path} (port ${port})`);
            return { path: created.path, port };
        } catch (error) {
            if (error instanceof WorktreeLimitError) {
                throw new RpcError(
                    RpcErrorCode.Rejected,
                    `这个项目的worktree已达上限（${error.message}），先删除用不到的`,
                );
            }
            throw error;
        }
    }

    port(threadId: string): Promise<number> {
        return allocatePort(threadId);
    }

    /** Runs the project's setup commands in a new worktree. Only for trusted projects (09 §5). */
    async runSetup(project: Project, worktree: string, port: number): Promise<{ ran: string[]; failed?: string }> {
        if (!project.trusted) {
            return { ran: [] };
        }
        const commands = await setupCommands(project.path);
        const ran: string[] = [];
        for (const command of commands) {
            const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
            const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
            const ok = await new Promise<boolean>((resolve) => {
                execFile(
                    shell,
                    args,
                    {
                        cwd: worktree,
                        timeout: SETUP_TIMEOUT_MS,
                        env: { ...process.env, XORA_PORT: String(port), ROOT_WORKTREE_PATH: project.path },
                    },
                    (error, _stdout, stderr) => {
                        if (error) {
                            this.#log.warn(`worktree setup "${command}" failed: ${stderr.slice(-500)}`);
                        }
                        resolve(!error);
                    },
                );
            });
            ran.push(command);
            if (!ok) {
                return { ran, failed: command };
            }
        }
        return { ran };
    }

    /** Snapshots the worktree, then removes it. */
    async remove(project: Project, threadId: string, worktree: string, force = false): Promise<void> {
        await this.#review.snapshot(worktree, `removed-${threadId}`);
        try {
            await this.#manager(project).remove(threadId, { force });
        } catch (error) {
            if (error instanceof WorktreeDirtyError) {
                throw new RpcError(RpcErrorCode.Rejected, 'worktree里还有未提交的改动；先应用到主目录，或者强制删除');
            }
            throw error;
        }
        releasePort(threadId);
    }

    async handoff(project: Project, from: string, to: string): Promise<HandoffResult> {
        await this.#requireRepo(project);
        const result = await this.#manager(project).handoff(from, to);
        if (result.status === 'moved' && result.tracked.length === 0 && result.untracked.length === 0) {
            return { ...toHandoff(result), status: 'nothing', message: '没有未提交的改动' };
        }
        return toHandoff(result);
    }

    async diff(dir: string, staged: boolean): Promise<{ files: DiffFile[]; isRepo: boolean; branch?: string }> {
        if (!(await findGit()) || !(await isGitRepo(dir))) {
            return { files: [], isRepo: false };
        }
        const files = await diffForReview(dir, staged ? { staged: true } : { untracked: true });
        let branch: string | undefined;
        try {
            const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, eol: 'user' });
            branch = result.code === 0 ? result.stdout.toString('utf8').trim() || undefined : undefined;
        } catch {
            branch = undefined;
        }
        return {
            files: files.map((file) => ({
                oldPath: file.oldPath,
                newPath: file.newPath,
                status: file.status,
                binary: file.binary,
                hunks: file.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line })) })),
            })),
            isRepo: true,
            ...(branch ? { branch } : {}),
        };
    }

    async hunks(
        dir: string,
        file: string,
        hunkIds: readonly string[],
        action: 'stage' | 'unstage' | 'revert',
        staged: boolean,
    ): Promise<void> {
        const files = await diffForReview(dir, staged ? { staged: true } : { untracked: true });
        const target = files.find((candidate) => candidate.newPath === file || candidate.oldPath === file);
        if (!target) {
            throw new RpcError(RpcErrorCode.NotFound, `no changes in ${file}`);
        }
        if (action === 'stage') await stageHunks(dir, target, hunkIds);
        else if (action === 'unstage') await unstageHunks(dir, target, hunkIds);
        else await revertHunks(dir, target, hunkIds);
    }

    async commit(dir: string, message: string, all: boolean): Promise<string> {
        const run = async (args: string[]) => {
            const result = await runGit(args, { cwd: dir, eol: 'user' });
            if (result.code !== 0) {
                throw new RpcError(
                    RpcErrorCode.Rejected,
                    `git ${args[0]} failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`,
                );
            }
            return result.stdout.toString('utf8').trim();
        };
        if (all) {
            await run(['add', '-A']);
        }
        await run(['commit', '-q', '-m', message]);
        return run(['rev-parse', 'HEAD']);
    }
}
