import {
    type Dirent,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { PromptLayerInput } from '@xora/engine';
import { bilingual, type PromptFile, type PromptLayer, RpcError, RpcErrorCode } from '@xora/protocol';
import { textOf } from './text.ts';

const TEXT = bilingual(
    {
        userGlobal: '用户全局',
        userGlobalNamed: (name: string) => `用户全局：${name}`,
        badName: '名称不能为空，不能以点开头，不能含有<>:"|?*这些字符，文件夹最多套三层',
        exists: (name: string) => `已经有叫“${name}”的提示词了`,
        missing: (name: string) => `找不到提示词“${name}”`,
        org: (name: string) => `组织：${name}`,
        projectShared: '项目·共享',
        projectPersonal: '项目·个人',
        agent: (name: string) => `agent：${name}`,
        session: '会话',
    },
    {
        userGlobal: 'User global',
        userGlobalNamed: (name) => `User global: ${name}`,
        badName:
            'A name cannot be empty, start with a dot or contain <>:"|?*, and folders go three levels deep at most',
        exists: (name) => `There is already a prompt called “${name}”`,
        missing: (name) => `There is no prompt called “${name}”`,
        org: (name) => `Organization: ${name}`,
        projectShared: 'Project (shared)',
        projectPersonal: 'Project (personal)',
        agent: (name) => `Agent: ${name}`,
        session: 'Session',
    },
);

/** Each layer is capped so one oversized file cannot crowd out the conversation. */
const MAX_LAYER_CHARS = 32_000;

/** Files projects use for shared agent instructions, in order of preference (08 §1.1). */
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * The global prompt before the prompt directory held several (≤1.1.0), `prompts/global.md`: still the one in use
 * until the user picks another.
 */
export const LEGACY_PROMPT = 'global';

/** Folders in the prompt directory go this deep: `a/b/name` at most. */
const MAX_DEPTH = 3;
const MAX_SEGMENT = 80;
const MAX_FILES = 500;
/** Names Windows cannot give a file, and characters it cannot have in one: new prompts stay portable. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_CHARS = /[<>:"|?*]/;

function hasControl(text: string): boolean {
    for (const char of text) {
        if (char.charCodeAt(0) < 32) return true;
    }
    return false;
}

/**
 * A prompt's name is its path in the prompt directory without `.md`, folders joined by `/`. Undefined when it is
 * not one; `strict` (new names) also refuses what a file could not be called on Windows.
 */
export function promptName(raw: string, strict = true): string | undefined {
    const segments = raw
        .trim()
        .replace(/\\/g, '/')
        .replace(/\.md$/i, '')
        .split('/')
        .map((segment) => segment.trim());
    if (segments.length > MAX_DEPTH) return undefined;
    for (const segment of segments) {
        if (!segment || segment.length > MAX_SEGMENT || segment.startsWith('.') || hasControl(segment)) {
            return undefined;
        }
        if (strict && (segment.endsWith('.') || WINDOWS_CHARS.test(segment) || RESERVED.test(segment))) {
            return undefined;
        }
    }
    return segments.join('/');
}

function readText(file: string): string | undefined {
    try {
        return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    } catch {
        return undefined;
    }
}

function cap(text: string): { text: string; truncated: boolean } {
    if (text.length <= MAX_LAYER_CHARS) {
        return { text, truncated: false };
    }
    return { text: `${text.slice(0, MAX_LAYER_CHARS)}\n…[truncated]`, truncated: true };
}

function estimate(text: string): number {
    let ascii = 0;
    let wide = 0;
    for (const char of text) {
        if (char.charCodeAt(0) < 128) ascii++;
        else wide++;
    }
    return Math.ceil(ascii / 4 + wide);
}

export interface LayerSources {
    readonly projectId: string;
    readonly projectRoot: string;
    /** Working directory of the thread, inside the project or one of its worktrees. */
    readonly cwd: string;
    readonly sessionPrompt: string;
    /** Organisation and agent layers (06 §4), when the thread belongs to a team. */
    readonly org?: { readonly name: string; readonly text: string; readonly source: string };
    readonly agent?: { readonly name: string; readonly text: string; readonly source: string };
}

/**
 * Prompt layers 2–7 (08 §1): user global, organisation, project shared (AGENTS.md chain), project private,
 * agent and session. The engine adds layer 1 (the unified system prompt) in front.
 *
 * The user global layer is one prompt of the prompt directory (08 §1.4): every `.md` file in it, folders included,
 * is a prompt, and the user picks the one in use (`selection`: absent until they first pick, `null` for none).
 */
export class PromptService {
    readonly #promptsDir: string;
    readonly #projectsDir: string;
    readonly #selection: () => string | null | undefined;

    constructor(promptsDir: string, projectsDir: string, selection: () => string | null | undefined = () => undefined) {
        this.#promptsDir = promptsDir;
        this.#projectsDir = projectsDir;
        this.#selection = selection;
    }

    /** The prompt directory, made on first use. */
    dir(): string {
        mkdirSync(this.#promptsDir, { recursive: true });
        return this.#promptsDir;
    }

    /** Every prompt in the directory, by name. Hidden files and folders are skipped; links to files count. */
    list(): PromptFile[] {
        const found: PromptFile[] = [];
        const walk = (dir: string, prefix: readonly string[]) => {
            let entries: Dirent[];
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (found.length >= MAX_FILES) return;
                if (entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (prefix.length + 1 < MAX_DEPTH) walk(full, [...prefix, entry.name]);
                    continue;
                }
                if (!/\.md$/i.test(entry.name)) continue;
                const name = promptName([...prefix, entry.name].join('/'), false);
                const stat = statOf(full);
                if (!name || !stat?.isFile()) continue;
                found.push({ name, path: full, chars: (readText(full) ?? '').length, modifiedAt: stat.mtimeMs });
            }
        };
        walk(this.dir(), []);
        return found.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The name of the prompt in use, which may have gone missing from the directory. */
    selected(): string | undefined {
        const chosen = this.#selection();
        if (chosen === null) return undefined;
        if (chosen === undefined) return this.#locate(LEGACY_PROMPT) ? LEGACY_PROMPT : undefined;
        return chosen;
    }

    /** The file of the prompt in use, when it exists. */
    selectedFile(): string | undefined {
        const name = promptName(this.selected() ?? '', false);
        return name ? this.#locate(name) : undefined;
    }

    /** The name of an existing prompt as the directory has it. */
    named(name: string): string {
        const clean = this.#name(name, false);
        if (!this.#locate(clean)) throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).missing(name));
        return clean;
    }

    read(name: string): { text: string; path: string } {
        const file = this.#locate(this.#name(name, false));
        if (!file) throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).missing(name));
        return { text: readText(file) ?? '', path: file };
    }

    /**
     * Writes a prompt. Without `previous` it is a new one and the name must be free; with it, the prompt called
     * `previous` is saved under `name`, renamed (and moved between folders) when the two differ.
     */
    save(name: string, text: string, previous?: string): PromptFile {
        const from = previous === undefined ? undefined : this.#name(previous, false);
        // Only a new name has to suit every system: a file the user put there keeps the name it has.
        const clean = from !== undefined && promptName(name, false) === from ? from : this.#name(name);
        let file = this.#pathOf(clean);
        const taken = this.#locate(clean);
        if (from === undefined) {
            if (taken) throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).exists(clean));
        } else {
            const source = this.#locate(from);
            if (!source) throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).missing(from));
            if (taken && !sameFile(taken, source)) {
                throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).exists(clean));
            }
            if (source === taken) {
                file = source;
            } else {
                // A new name, or the same one in another case.
                mkdirSync(path.dirname(file), { recursive: true });
                renameSync(source, file);
                this.#prune(path.dirname(source));
            }
        }
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text, 'utf8');
        return { name: clean, path: file, chars: text.length, modifiedAt: statOf(file)?.mtimeMs ?? Date.now() };
    }

    remove(name: string): void {
        const file = this.#locate(this.#name(name, false));
        if (!file) throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).missing(name));
        unlinkSync(file);
        this.#prune(path.dirname(file));
    }

    /** The text of the prompt in use. */
    readGlobal(): string {
        const file = this.selectedFile();
        return file ? (readText(file) ?? '') : '';
    }

    /**
     * Writes the prompt in use; with none in use, the legacy one, which the caller then puts in use. Returns the
     * name written.
     */
    writeGlobal(text: string): string {
        const name = this.selected() ?? LEGACY_PROMPT;
        const file = this.#locate(name) ?? this.#pathOf(name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text, 'utf8');
        return name;
    }

    projectFile(projectId: string): string {
        return path.join(this.#projectsDir, projectId, 'instructions.md');
    }

    readProject(projectId: string): string {
        return readText(this.projectFile(projectId)) ?? '';
    }

    writeProject(projectId: string, text: string): void {
        mkdirSync(path.dirname(this.projectFile(projectId)), { recursive: true });
        writeFileSync(this.projectFile(projectId), text, 'utf8');
    }

    /** AGENTS.md files from the project root down to `cwd`, root first, so deeper files can refine. */
    projectInstructionFiles(projectRoot: string, cwd: string): string[] {
        const dirs: string[] = [];
        let current = path.resolve(cwd);
        const root = path.resolve(projectRoot);
        while (current.startsWith(root)) {
            dirs.unshift(current);
            if (current === root) {
                break;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        if (dirs[0] !== root) {
            dirs.unshift(root);
        }
        const files: string[] = [];
        for (const dir of dirs) {
            const found = PROJECT_FILES.map((name) => path.join(dir, name)).find((file) => existsSync(file));
            if (found) {
                files.push(found);
            }
        }
        return files;
    }

    layers(sources: LayerSources): PromptLayer[] {
        const titles = textOf(TEXT);
        const layers: PromptLayer[] = [];
        const push = (id: string, title: string, source: string, raw: string | undefined, editable: boolean) => {
            if (!raw || raw.trim().length === 0) {
                return;
            }
            const { text, truncated } = cap(raw.trim());
            layers.push({ id, title, source, text, chars: text.length, tokens: estimate(text), truncated, editable });
        };
        const selected = this.selected();
        const selectedFile = this.selectedFile();
        push(
            'user_global_instructions',
            selected ? titles.userGlobalNamed(selected) : titles.userGlobal,
            selectedFile ?? this.#promptsDir,
            selectedFile ? readText(selectedFile) : undefined,
            true,
        );
        if (sources.org) {
            push('org_instructions', titles.org(sources.org.name), sources.org.source, sources.org.text, false);
        }
        const files = this.projectInstructionFiles(sources.projectRoot, sources.cwd);
        if (files.length > 0) {
            const text = files
                .map(
                    (file) =>
                        `# ${path.relative(sources.projectRoot, file) || path.basename(file)}\n${readText(file) ?? ''}`,
                )
                .join('\n\n');
            push('project_instructions', titles.projectShared, files.join(', '), text, false);
        }
        push(
            'project_private_instructions',
            titles.projectPersonal,
            this.projectFile(sources.projectId),
            this.readProject(sources.projectId),
            true,
        );
        if (sources.agent) {
            push(
                'agent_instructions',
                titles.agent(sources.agent.name),
                sources.agent.source,
                sources.agent.text,
                false,
            );
        }
        push('session_instructions', titles.session, 'thread', sources.sessionPrompt, true);
        return layers;
    }

    /** The layers as the engine receives them. */
    engineLayers(sources: LayerSources): PromptLayerInput[] {
        return this.layers(sources).map((layer) => ({ id: layer.id, title: layer.title, text: layer.text }));
    }

    #name(raw: string, strict = true): string {
        const name = promptName(raw, strict);
        if (!name) throw new RpcError(RpcErrorCode.InvalidParams, textOf(TEXT).badName);
        return name;
    }

    #pathOf(name: string): string {
        return `${path.join(this.#promptsDir, ...name.split('/'))}.md`;
    }

    /** The file of a prompt; on systems that tell cases apart, `.MD` and the like count too. */
    #locate(name: string): string | undefined {
        const exact = this.#pathOf(name);
        if (statOf(exact)?.isFile()) return exact;
        const dir = path.dirname(exact);
        const stem = path.basename(exact).slice(0, -3);
        try {
            const hit = readdirSync(dir).find((file) => file.slice(0, -3) === stem && /\.md$/i.test(file));
            return hit && statOf(path.join(dir, hit))?.isFile() ? path.join(dir, hit) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Drops folders a rename or removal left empty, up to the prompt directory. */
    #prune(dir: string): void {
        const root = path.resolve(this.#promptsDir);
        let current = path.resolve(dir);
        while (current !== root && current.startsWith(root + path.sep)) {
            try {
                if (readdirSync(current).length > 0) return;
                rmdirSync(current);
            } catch {
                return;
            }
            current = path.dirname(current);
        }
    }
}

function statOf(file: string) {
    try {
        return statSync(file);
    } catch {
        return undefined;
    }
}

/** Two paths of one file: a rename that only changes case on systems that ignore it. */
function sameFile(a: string, b: string): boolean {
    const first = statOf(a);
    const second = statOf(b);
    return Boolean(first && second && first.ino === second.ino && first.dev === second.dev);
}
