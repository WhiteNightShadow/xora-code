import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PromptLayerInput } from '@xora/engine';
import type { PromptLayer } from '@xora/protocol';

/** Each layer is capped so one oversized file cannot crowd out the conversation. */
const MAX_LAYER_CHARS = 32_000;

/** Files projects use for shared agent instructions, in order of preference (08 §1.1). */
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md'];

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
 */
export class PromptService {
    readonly #promptsDir: string;
    readonly #projectsDir: string;

    constructor(promptsDir: string, projectsDir: string) {
        this.#promptsDir = promptsDir;
        this.#projectsDir = projectsDir;
    }

    globalFile(): string {
        return path.join(this.#promptsDir, 'global.md');
    }

    projectFile(projectId: string): string {
        return path.join(this.#projectsDir, projectId, 'instructions.md');
    }

    readGlobal(): string {
        return readText(this.globalFile()) ?? '';
    }

    writeGlobal(text: string): void {
        mkdirSync(this.#promptsDir, { recursive: true });
        writeFileSync(this.globalFile(), text, 'utf8');
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
        const layers: PromptLayer[] = [];
        const push = (id: string, title: string, source: string, raw: string | undefined, editable: boolean) => {
            if (!raw || raw.trim().length === 0) {
                return;
            }
            const { text, truncated } = cap(raw.trim());
            layers.push({ id, title, source, text, chars: text.length, tokens: estimate(text), truncated, editable });
        };
        push('user_global_instructions', '用户全局', this.globalFile(), this.readGlobal(), true);
        if (sources.org) {
            push('org_instructions', `组织：${sources.org.name}`, sources.org.source, sources.org.text, false);
        }
        const files = this.projectInstructionFiles(sources.projectRoot, sources.cwd);
        if (files.length > 0) {
            const text = files
                .map(
                    (file) =>
                        `# ${path.relative(sources.projectRoot, file) || path.basename(file)}\n${readText(file) ?? ''}`,
                )
                .join('\n\n');
            push('project_instructions', '项目·共享', files.join(', '), text, false);
        }
        push(
            'project_private_instructions',
            '项目·个人',
            this.projectFile(sources.projectId),
            this.readProject(sources.projectId),
            true,
        );
        if (sources.agent) {
            push('agent_instructions', `agent：${sources.agent.name}`, sources.agent.source, sources.agent.text, false);
        }
        push('session_instructions', '会话', 'thread', sources.sessionPrompt, true);
        return layers;
    }

    /** The layers as the engine receives them. */
    engineLayers(sources: LayerSources): PromptLayerInput[] {
        return this.layers(sources).map((layer) => ({ id: layer.id, title: layer.title, text: layer.text }));
    }
}
