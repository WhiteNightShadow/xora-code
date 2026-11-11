import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where memory lives on disk (06 §19, §21, 20 §4.6): plain Markdown the user can read and edit, one note a line.
 *
 * - `<orgs>/default/user.md`: the user's preferences, read by every thread
 * - `<orgs>/default/memory/<project>.md`: everyone's notes in a project
 * - `<orgs>/default/groups/<group>/projects/<project>.md`: an organization's notes in a project
 * - `<members>/<member>/memory.md`: a member's general notes
 * - `<members>/<member>/projects/<project>.md`: a member's notes in a project
 *
 * Project folders keep the display names of their files in `names.json`, for projects the app no longer knows.
 */

/** A member's folder, or a group's: its id when that is a safe file name, else a hash of it. */
export function folderName(id: string): string {
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) && !id.includes('..')
        ? id
        : `x-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** A project's memory file name: project ids are safe as they are; anything else is hashed. */
export function projectStem(projectId: string): string {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(projectId) && !projectId.includes('..')
        ? projectId
        : `x-${createHash('sha256').update(projectId).digest('hex').slice(0, 16)}`;
}

/** Display names of the project files in a memory folder (`names.json`). */
export async function readNames(dir: string): Promise<Record<string, string>> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path.join(dir, 'names.json'), 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

export async function writeAtomic(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
}

/** Work on one key runs one after another: two notes written at once must not lose one of them. */
export class Serial {
    readonly #queues = new Map<string, Promise<unknown>>();

    run<T>(key: string, work: () => Promise<T>): Promise<T> {
        const next = (this.#queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
        this.#queues.set(key, next);
        void next
            .finally(() => {
                if (this.#queues.get(key) === next) this.#queues.delete(key);
            })
            .catch(() => undefined);
        return next;
    }
}

/** The paths of every part of memory. */
export class MemoryPaths {
    readonly #membersDir: string;
    readonly #orgsDir: string;

    constructor(membersDir: string, orgsDir: string) {
        this.#membersDir = membersDir;
        this.#orgsDir = orgsDir;
    }

    get membersDir(): string {
        return this.#membersDir;
    }

    /** The user's preferences: what every thread, every member's included, should know of them. */
    user(): string {
        return path.join(this.#orgsDir, 'default', 'user.md');
    }

    /** Everyone's notes in each project. */
    rootDir(): string {
        return path.join(this.#orgsDir, 'default', 'memory');
    }

    root(projectId: string): string {
        return path.join(this.rootDir(), `${projectStem(projectId)}.md`);
    }

    groupDir(groupId: string): string {
        return path.join(this.#orgsDir, 'default', 'groups', folderName(groupId), 'projects');
    }

    /** What an organization keeps of a project; everyone's without one (19 §7). */
    org(groupId: string | undefined, projectId: string): string {
        return groupId === undefined
            ? this.root(projectId)
            : path.join(this.groupDir(groupId), `${projectStem(projectId)}.md`);
    }

    /** A member's general notes: how it works and what the user prefers, in every project. */
    member(memberId: string): string {
        return path.join(this.#membersDir, folderName(memberId), 'memory.md');
    }

    memberProjectsDir(memberId: string): string {
        return path.join(this.#membersDir, folderName(memberId), 'projects');
    }

    /** A member's notes in one project. */
    memberProject(memberId: string, projectId: string): string {
        return path.join(this.memberProjectsDir(memberId), `${projectStem(projectId)}.md`);
    }
}
