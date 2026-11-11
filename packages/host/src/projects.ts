import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { bilingual, type ModelRef, type PermissionMode, type Project, RpcError, RpcErrorCode } from '@xora/protocol';
import { fromJson, toJson, type XoraDatabase } from '@xora/storage';
import { currentBranch, isGitRepo } from '@xora/workspace';
import type { Bus } from './bus.ts';
import { newId } from './ids.ts';
import { textOf } from './text.ts';

const TEXT = bilingual(
    {
        folderMissing: (dir: string) => `文件夹不存在：${dir}`,
        notFolder: (dir: string) => `不是文件夹：${dir}`,
    },
    {
        folderMissing: (dir) => `The folder does not exist: ${dir}`,
        notFolder: (dir) => `Not a folder: ${dir}`,
    },
);

interface ProjectRow {
    id: string;
    name: string;
    path: string;
    added_at: number;
    last_opened_at: number | null;
    trusted: number;
    defaults_json: string | null;
}

/** Projects are folders the user opened; the path is stored as its real path so symlinked opens dedupe. */
export class ProjectService {
    readonly #db: XoraDatabase;
    readonly #bus: Bus;
    readonly #git = new Map<string, { isRepo: boolean; branch?: string; at: number }>();

    constructor(db: XoraDatabase, bus: Bus) {
        this.#db = db;
        this.#bus = bus;
    }

    async #gitInfo(dir: string): Promise<{ isRepo: boolean; branch?: string }> {
        const cached = this.#git.get(dir);
        if (cached && Date.now() - cached.at < 10_000) {
            return cached;
        }
        let info: { isRepo: boolean; branch?: string } = { isRepo: false };
        try {
            if (await isGitRepo(dir)) {
                const branch = await currentBranch(dir);
                info = { isRepo: true, ...(branch ? { branch } : {}) };
            }
        } catch {
            info = { isRepo: false };
        }
        this.#git.set(dir, { ...info, at: Date.now() });
        return info;
    }

    async #toProject(row: ProjectRow): Promise<Project> {
        const missing = !existsSync(row.path);
        const defaults = fromJson<{ mode?: PermissionMode; model?: ModelRef } | null>(row.defaults_json, null);
        return {
            id: row.id,
            name: row.name,
            path: row.path,
            addedAt: row.added_at,
            ...(row.last_opened_at ? { lastOpenedAt: row.last_opened_at } : {}),
            trusted: row.trusted === 1,
            git: missing ? { isRepo: false } : await this.#gitInfo(row.path),
            ...(missing ? { missing: true } : {}),
            ...(defaults ? { defaults } : {}),
        };
    }

    #row(projectId: string): ProjectRow {
        const row = this.#db.get<ProjectRow>('select * from projects where id = ?', [projectId]);
        if (!row) {
            throw new RpcError(RpcErrorCode.NotFound, `project not found: ${projectId}`);
        }
        return row;
    }

    async list(): Promise<Project[]> {
        const rows = this.#db.all<ProjectRow>(
            'select * from projects order by coalesce(last_opened_at, added_at) desc',
        );
        return Promise.all(rows.map((row) => this.#toProject(row)));
    }

    async get(projectId: string): Promise<Project> {
        return this.#toProject(this.#row(projectId));
    }

    rootOf(projectId: string): string {
        return this.#row(projectId).path;
    }

    /** The project's name, for text built where only its id is at hand. */
    nameOf(projectId: string): string {
        return this.#row(projectId).name;
    }

    async add(dir: string): Promise<Project> {
        let real: string;
        try {
            real = realpathSync(path.resolve(dir));
        } catch {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).folderMissing(dir));
        }
        if (!statSync(real).isDirectory()) {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).notFolder(dir));
        }
        const existing = this.#db.get<ProjectRow>('select * from projects where path = ?', [real]);
        if (existing) {
            this.touch(existing.id);
            return this.get(existing.id);
        }
        const id = newId('p');
        const now = Date.now();
        this.#db.run(
            'insert into projects (id, name, path, added_at, last_opened_at, trusted) values (?, ?, ?, ?, ?, 0)',
            [id, path.basename(real) || real, real, now, now],
        );
        const project = await this.get(id);
        this.#bus.broadcast('project.changed', { project });
        return project;
    }

    touch(projectId: string): void {
        this.#db.run('update projects set last_opened_at = ? where id = ?', [Date.now(), projectId]);
    }

    async update(
        projectId: string,
        patch: { name?: string; trusted?: boolean; defaults?: { mode?: PermissionMode; model?: ModelRef } },
    ): Promise<Project> {
        const row = this.#row(projectId);
        this.#db.run('update projects set name = ?, trusted = ?, defaults_json = ? where id = ?', [
            patch.name ?? row.name,
            patch.trusted === undefined ? row.trusted : patch.trusted ? 1 : 0,
            patch.defaults === undefined ? row.defaults_json : toJson(patch.defaults),
            projectId,
        ]);
        const project = await this.get(projectId);
        this.#bus.broadcast('project.changed', { project });
        return project;
    }

    remove(projectId: string): void {
        this.#row(projectId);
        this.#db.run('delete from projects where id = ?', [projectId]);
        this.#bus.broadcast('project.removed', { projectId });
    }
}
