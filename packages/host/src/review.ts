import path from 'node:path';
import type { FileChange, RevertResult } from '@xora/protocol';
import { CheckpointStore, findGit } from '@xora/workspace';
import type { Logger } from './log.ts';

/**
 * Per-turn checkpoints (04 §4): a shadow git repository per work tree snapshots the files before and after
 * every turn, without touching the user's own repository. Diffs and undo are computed between snapshots.
 */
export class ReviewService {
    readonly #checkpointsDir: string;
    readonly #log: Logger;
    readonly #stores = new Map<string, CheckpointStore>();
    #available: boolean | undefined;

    constructor(checkpointsDir: string, log: Logger) {
        this.#checkpointsDir = checkpointsDir;
        this.#log = log;
    }

    async available(): Promise<boolean> {
        if (this.#available === undefined) {
            try {
                this.#available = Boolean(await findGit());
            } catch {
                this.#available = false;
            }
            if (!this.#available) {
                this.#log.warn('git not found: per-turn diffs and undo are disabled');
            }
        }
        return this.#available;
    }

    /** One shadow repository per work tree (the project folder, or a worktree of it). */
    async #store(workTree: string): Promise<CheckpointStore> {
        let store = this.#stores.get(workTree);
        if (!store) {
            const name = Buffer.from(path.resolve(workTree)).toString('base64url').slice(-80);
            store = new CheckpointStore({ gitDir: path.join(this.#checkpointsDir, `${name}.git`), workTree });
            await store.init();
            this.#stores.set(workTree, store);
        }
        return store;
    }

    /** Returns the snapshot tree id, or undefined when checkpoints are unavailable. */
    async snapshot(workTree: string, label: string): Promise<string | undefined> {
        if (!(await this.available())) {
            return undefined;
        }
        try {
            const store = await this.#store(workTree);
            return (await store.snapshot(label)).tree;
        } catch (error) {
            this.#log.warn(
                `checkpoint failed in ${workTree}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
        }
    }

    async changes(workTree: string, before: string, after: string): Promise<FileChange[]> {
        const store = await this.#store(workTree);
        return (await store.changes(before, after)).map((change) => ({
            path: change.path,
            ...(change.oldPath ? { oldPath: change.oldPath } : {}),
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            binary: change.binary,
        }));
    }

    async file(workTree: string, before: string, after: string, file: string) {
        const store = await this.#store(workTree);
        return store.fileVersions(before, after, file);
    }

    /** Puts files back to `before`, skipping any the user changed after the turn unless `force`. */
    async revert(
        workTree: string,
        before: string,
        after: string,
        paths: readonly string[],
        force = false,
    ): Promise<RevertResult> {
        const store = await this.#store(workTree);
        const result = await store.restore(before, paths, { expectTree: after, force });
        return {
            restored: [...result.restored],
            deleted: [...result.deleted],
            conflicts: result.conflicts.map((conflict) => ({ path: conflict.path, reason: conflict.reason })),
        };
    }
}
