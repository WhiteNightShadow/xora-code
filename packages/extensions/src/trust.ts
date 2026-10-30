import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { errorCode, isSameOrInside, realOrResolved, writeJsonAtomic } from './fs-utils.ts';
import type { ExtensionOrigin } from './types.ts';

/**
 * Trust (09 §5, 10 §1): built-in and user extensions are enabled; a project's extensions are enabled once the user
 * trusts the project; in an untrusted project hooks and MCP servers are off and skills can be read but their
 * scripts are not run; plugins run once their permissions were confirmed at install.
 */

export interface EffectiveTrust {
    /** Whether the source counts as trusted at all; the value for `ExtensionSource.trusted`. */
    readonly trusted: boolean;
    readonly runHooks: boolean;
    readonly startMcpServers: boolean;
    /** Skills are listed and their files can be read. */
    readonly readSkills: boolean;
    /** Scripts shipped with skills may be run. */
    readonly runSkillScripts: boolean;
    readonly useCommands: boolean;
    /** Agent definitions may be used. From an untrusted source they must not raise permission modes. */
    readonly useAgents: boolean;
}

/**
 * What extensions from `origin` may do. `trusted` is whether the project is trusted (project origin) or whether
 * the plugin is enabled with confirmed permissions (plugin origin); it is ignored for user and built-in origins.
 */
export function effectiveTrust(origin: ExtensionOrigin, trusted: boolean): EffectiveTrust {
    const ok = origin === 'user' || origin === 'builtin' || trusted;
    if (origin === 'plugin' && !ok) {
        // A disabled or unconfirmed plugin contributes nothing.
        return {
            trusted: false,
            runHooks: false,
            startMcpServers: false,
            readSkills: false,
            runSkillScripts: false,
            useCommands: false,
            useAgents: false,
        };
    }
    return {
        trusted: ok,
        runHooks: ok,
        startMcpServers: ok,
        readSkills: true,
        runSkillScripts: ok,
        useCommands: true,
        useAgents: true,
    };
}

const TrustFileSchema = z.object({
    schemaVersion: z.literal(1),
    projects: z.array(z.object({ path: z.string(), trustedAt: z.string() })),
});

export type TrustedProject = z.infer<typeof TrustFileSchema>['projects'][number];

/**
 * Trusted project roots, kept in a JSON file. Paths are stored as real paths; a directory inside a trusted root
 * is trusted too. An unreadable file is moved aside and nothing is trusted, which is the safe default.
 */
export class TrustStore {
    readonly file: string;
    readonly #now: () => Date;
    #queue: Promise<unknown> = Promise.resolve();

    constructor(file: string, options: { readonly now?: () => Date } = {}) {
        this.file = file;
        this.#now = options.now ?? (() => new Date());
    }

    async list(): Promise<TrustedProject[]> {
        return (await this.#load()).projects;
    }

    /** Whether `dir` is a trusted project root or inside one. */
    async isTrusted(dir: string): Promise<boolean> {
        const real = await realOrResolved(dir);
        return (await this.#load()).projects.some((project) => sameOrInside(project.path, real));
    }

    /** Trusts `dir` and returns the real path that was stored. A filesystem root cannot be trusted. */
    trust(dir: string): Promise<string> {
        return this.#serialize(async () => {
            const real = await realOrResolved(dir);
            if (path.parse(real).root === real) {
                throw new Error(`refusing to trust a filesystem root: ${real}`);
            }
            const state = await this.#load();
            if (!state.projects.some((project) => samePath(project.path, real))) {
                state.projects.push({ path: real, trustedAt: this.#now().toISOString() });
                await writeJsonAtomic(this.file, state);
            }
            return real;
        });
    }

    /**
     * Removes `dir` from the trusted roots. Returns false when it was not a root itself; a directory trusted
     * through a parent stays trusted until the parent is untrusted.
     */
    untrust(dir: string): Promise<boolean> {
        return this.#serialize(async () => {
            const real = await realOrResolved(dir);
            const state = await this.#load();
            const kept = state.projects.filter((project) => !samePath(project.path, real));
            if (kept.length === state.projects.length) {
                return false;
            }
            await writeJsonAtomic(this.file, { ...state, projects: kept });
            return true;
        });
    }

    #serialize<T>(task: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }

    async #load(): Promise<z.infer<typeof TrustFileSchema>> {
        let text: string;
        try {
            text = await readFile(this.file, 'utf8');
        } catch (error) {
            if (errorCode(error) === 'ENOENT') {
                return { schemaVersion: 1, projects: [] };
            }
            throw error;
        }
        try {
            return TrustFileSchema.parse(JSON.parse(text));
        } catch {
            await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
            return { schemaVersion: 1, projects: [] };
        }
    }
}

/** Windows paths compare without case; elsewhere the real path decides. */
function normalizeCase(file: string): string {
    return process.platform === 'win32' ? file.toLowerCase() : file;
}

function samePath(a: string, b: string): boolean {
    return normalizeCase(a) === normalizeCase(b);
}

function sameOrInside(root: string, candidate: string): boolean {
    return isSameOrInside(normalizeCase(root), normalizeCase(candidate));
}
