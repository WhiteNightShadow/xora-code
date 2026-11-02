import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidSkillName, loadSkill, parseFrontmatter, type Skill } from '@xora/extensions';

/**
 * Skills from GitHub for members (06 §21): search repositories for folders with a `SKILL.md`, and install one,
 * pinned to a commit, into the skill library (`<data>/skill-library/<name>/`). The library is not one of the
 * skill sources every thread gets: a member gets the skills its agent file lists. Nothing is installed without the
 * user's approval, and installed skills are untrusted (read, not run) until the user says otherwise.
 */

export interface SkillCandidate {
    /** `owner/name`. */
    readonly repo: string;
    /** Path of the `SKILL.md` in the repository. */
    readonly path: string;
    readonly name: string;
    readonly description: string;
    readonly stars: number;
    readonly license?: string;
    readonly updatedAt?: string;
    /** The commit it was found at: an install takes exactly this. */
    readonly ref: string;
    readonly url: string;
}

export interface LibrarySkill {
    readonly name: string;
    readonly description: string;
    readonly dir: string;
    readonly repo?: string;
    readonly ref?: string;
    readonly installedAt?: number;
}

export interface HubOptions {
    readonly fetch?: typeof fetch;
    /** A GitHub token from the environment, for a higher rate limit; anonymous otherwise. */
    readonly token?: string;
    readonly timeoutMs?: number;
}

export class HubError extends Error {}

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MAX_REPOS = 6;
const MAX_PER_REPO = 6;
const MAX_CANDIDATES = 12;
const MAX_FILES = 60;
const MAX_BYTES = 3 * 1024 * 1024;
const SOURCE_FILE = '.source.json';

function headers(options: HubOptions, accept: string): Record<string, string> {
    return {
        accept,
        'user-agent': 'xora-code',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    };
}

async function get(url: string, options: HubOptions, accept: string): Promise<Response> {
    const response = await (options.fetch ?? fetch)(url, {
        headers: headers(options, accept),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!response.ok) {
        const limited = response.status === 403 || response.status === 429;
        throw new HubError(
            limited
                ? 'GitHub refused the request: its rate limit for anonymous use is spent; try again in an hour, or set GH_TOKEN'
                : `GitHub answered ${response.status} for ${url}`,
        );
    }
    return response;
}

async function getJson<T>(url: string, options: HubOptions): Promise<T> {
    return (await (await get(url, options, 'application/vnd.github+json')).json()) as T;
}

async function getText(url: string, options: HubOptions, accept = 'text/plain'): Promise<string> {
    return (await get(url, options, accept)).text();
}

function rawUrl(repo: string, ref: string, file: string): string {
    return `${RAW}/${repo}/${ref}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

interface RepoItem {
    readonly full_name: string;
    readonly html_url: string;
    readonly stargazers_count: number;
    readonly default_branch: string;
    readonly pushed_at?: string;
    readonly license?: { readonly spdx_id?: string } | null;
}

interface TreeEntry {
    readonly path: string;
    readonly type: string;
    readonly size?: number;
}

/**
 * Skills about `query`: the most starred repositories that mention it and skills, and the `SKILL.md` folders in
 * them with their name and description, the ones whose words match the query first.
 */
export async function searchSkills(query: string, options: HubOptions = {}): Promise<SkillCandidate[]> {
    const q = `${query} skill in:name,description,readme`;
    const found = await getJson<{ items?: RepoItem[] }>(
        `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`,
        options,
    );
    const out: SkillCandidate[] = [];
    for (const repo of (found.items ?? []).slice(0, MAX_REPOS)) {
        if (out.length >= MAX_CANDIDATES) break;
        try {
            const ref = (
                await getText(
                    `${API}/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`,
                    options,
                    'application/vnd.github.sha',
                )
            ).trim();
            const tree = await getJson<{ tree?: TreeEntry[] }>(
                `${API}/repos/${repo.full_name}/git/trees/${ref}?recursive=1`,
                options,
            );
            const files = (tree.tree ?? [])
                .filter((entry) => entry.type === 'blob' && /(^|\/)SKILL\.md$/.test(entry.path))
                .slice(0, MAX_PER_REPO);
            for (const file of files) {
                const { data } = parseFrontmatter(await getText(rawUrl(repo.full_name, ref, file.path), options));
                const name = text(data.name);
                const description = text(data.description);
                if (!name || !description) continue;
                const folder = path.posix.dirname(file.path);
                out.push({
                    repo: repo.full_name,
                    path: file.path,
                    name,
                    description: description.length > 300 ? `${description.slice(0, 300)}…` : description,
                    stars: repo.stargazers_count,
                    ...(repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
                        ? { license: repo.license.spdx_id }
                        : {}),
                    ...(repo.pushed_at ? { updatedAt: repo.pushed_at } : {}),
                    ref,
                    url: `${repo.html_url}/tree/${ref}${folder === '.' ? '' : `/${folder}`}`,
                });
            }
        } catch (error) {
            if (error instanceof HubError && /rate limit/.test(error.message) && out.length === 0) throw error;
        }
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (candidate: SkillCandidate) =>
        words.filter((word) => `${candidate.name} ${candidate.description}`.toLowerCase().includes(word)).length;
    return out
        .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, MAX_CANDIDATES)
        .map((entry) => entry.candidate);
}

/** A folder name for a skill: its own name when that is a valid skill name, else a slug of it. */
function skillFolder(name: string): string {
    if (isValidSkillName(name)) return name;
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return slug || `skill-${randomBytes(3).toString('hex')}`;
}

/**
 * Installs the skill folder of `path` in `repo` at commit `ref` into the library, replacing an earlier install of
 * the same name. Refuses more than 60 files or 3 MB.
 */
export async function installSkill(
    input: { readonly repo: string; readonly path: string; readonly ref: string },
    libraryDir: string,
    options: HubOptions = {},
): Promise<LibrarySkill & { readonly files: number }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new HubError(`Not a repository: ${input.repo}`);
    if (!/^[0-9a-f]{40}$/.test(input.ref)) throw new HubError(`Not a commit: ${input.ref}`);
    const skillPath = input.path.replace(/^\/+/, '');
    if (!/(^|\/)SKILL\.md$/.test(skillPath) || skillPath.split('/').includes('..')) {
        throw new HubError(`Not a SKILL.md path: ${input.path}`);
    }
    const base = path.posix.dirname(skillPath);
    const tree = await getJson<{ tree?: TreeEntry[] }>(
        `${API}/repos/${input.repo}/git/trees/${input.ref}?recursive=1`,
        options,
    );
    const files = (tree.tree ?? []).filter(
        (entry) =>
            entry.type === 'blob' && (base === '.' ? !entry.path.includes('/') : entry.path.startsWith(`${base}/`)),
    );
    if (!files.some((entry) => entry.path === skillPath)) throw new HubError(`${skillPath} is not in ${input.repo}`);
    if (files.length > MAX_FILES) throw new HubError(`The skill has ${files.length} files, more than ${MAX_FILES}`);
    const bytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (bytes > MAX_BYTES) throw new HubError(`The skill is ${bytes} bytes, more than ${MAX_BYTES}`);

    const skillText = await getText(rawUrl(input.repo, input.ref, skillPath), options);
    const name = skillFolder(text(parseFrontmatter(skillText).data.name) || path.posix.basename(base));
    await mkdir(libraryDir, { recursive: true });
    const temp = path.join(libraryDir, `.tmp-${randomBytes(4).toString('hex')}`);
    try {
        for (const entry of files) {
            const relative = base === '.' ? entry.path : entry.path.slice(base.length + 1);
            if (relative.split('/').some((part) => part === '..' || part === '')) continue;
            const target = path.join(temp, ...relative.split('/'));
            const content =
                entry.path === skillPath
                    ? Buffer.from(skillText, 'utf8')
                    : Buffer.from(
                          await (await get(rawUrl(input.repo, input.ref, entry.path), options, '*/*')).arrayBuffer(),
                      );
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);
        }
        const installedAt = Date.now();
        await writeFile(
            path.join(temp, SOURCE_FILE),
            `${JSON.stringify({ repo: input.repo, path: skillPath, ref: input.ref, installedAt }, null, 2)}\n`,
        );
        const loaded = await loadSkill(temp, { dir: libraryDir, origin: 'user', trusted: false });
        if (!loaded.skill) {
            throw new HubError(`Not a valid skill: ${loaded.diagnostics.map((item) => item.message).join('; ')}`);
        }
        const dir = path.join(libraryDir, name);
        await rm(dir, { recursive: true, force: true });
        await rename(temp, dir);
        return {
            name,
            description: loaded.skill.description,
            dir,
            repo: input.repo,
            ref: input.ref,
            installedAt,
            files: files.length,
        };
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

async function sourceOf(dir: string): Promise<{ repo?: string; ref?: string; installedAt?: number }> {
    try {
        const parsed = JSON.parse(await readFile(path.join(dir, SOURCE_FILE), 'utf8')) as Record<string, unknown>;
        return {
            ...(typeof parsed.repo === 'string' ? { repo: parsed.repo } : {}),
            ...(typeof parsed.ref === 'string' ? { ref: parsed.ref } : {}),
            ...(typeof parsed.installedAt === 'number' ? { installedAt: parsed.installedAt } : {}),
        };
    } catch {
        return {};
    }
}

/** The skills in the library. */
export async function listLibrary(libraryDir: string): Promise<LibrarySkill[]> {
    const names = await readdir(libraryDir).catch(() => [] as string[]);
    const out: LibrarySkill[] = [];
    for (const name of names.filter((entry) => !entry.startsWith('.')).sort()) {
        const dir = path.join(libraryDir, name);
        const loaded = await loadSkill(dir, { dir: libraryDir, origin: 'user', trusted: false });
        if (loaded.skill) {
            out.push({ name, description: loaded.skill.description, dir, ...(await sourceOf(dir)) });
        }
    }
    return out;
}

/** The library skills a member lists, for its skill index; unknown names are left out. */
export async function memberSkills(libraryDir: string, names: readonly string[]): Promise<Skill[]> {
    const out: Skill[] = [];
    for (const name of names) {
        if (!isValidSkillName(name)) continue;
        const loaded = await loadSkill(path.join(libraryDir, name), {
            dir: libraryDir,
            origin: 'user',
            trusted: false,
        });
        if (loaded.skill) out.push(loaded.skill);
    }
    return out;
}
