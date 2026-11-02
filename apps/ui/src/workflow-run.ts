import type { Project, WorkflowRun, WorkflowStepRun } from '@xora/protocol';

/** Each step's column in the flow: one after the deepest step it needs. */
export function flowLevels(steps: readonly WorkflowStepRun[]): Map<string, number> {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const levels = new Map<string, number>();
    const visit = (id: string, trail: Set<string>): number => {
        const known = levels.get(id);
        if (known !== undefined) return known;
        const step = byId.get(id);
        // An unknown step or a cycle: the host refuses both, so this only keeps a broken record drawable.
        if (!step || trail.has(id)) return -1;
        trail.add(id);
        const level = step.needs.reduce((deepest, need) => Math.max(deepest, visit(need, trail) + 1), 0);
        trail.delete(id);
        levels.set(id, level);
        return level;
    };
    for (const step of steps) visit(step.id, new Set());
    return levels;
}

/** Extensions a bare file name (one without a folder) must have to count as a file, not a version or a domain. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
    (
        'md markdown mdx txt rst adoc json jsonl yaml yml toml ini cfg conf env csv tsv xml html htm css scss ' +
        'js mjs cjs ts tsx jsx vue svelte py ipynb rb go rs java kt kts swift m mm c h cc cpp hpp cs php lua sh ' +
        'bash zsh ps1 bat sql graphql proto gradle log diff patch png jpg jpeg gif webp svg ico pdf docx xlsx pptx zip'
    ).split(' '),
);

/**
 * The files a value names in the project: one or several relative paths separated by commas or lines. A path under
 * the project root is made relative. A path counts when it has a folder and an extension, or, alone, a well-known
 * file extension; anything else (prose, a URL, a version, a domain, an absolute path outside the project) names none.
 */
export function filesIn(value: string, root: string): string[] {
    const parts = value
        .split(/[\n,，;；]+/)
        .map((part) => part.trim().replace(/^[`'"]|[`'"]$/g, ''))
        .filter(Boolean);
    const files: string[] = [];
    for (const part of parts) {
        let text = part;
        if (root && (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`))) {
            text = text.slice(root.length + 1);
        }
        const extension = /\.([A-Za-z][A-Za-z0-9]{0,7})$/.exec(text)?.[1]?.toLowerCase();
        const plain =
            extension !== undefined &&
            text.length <= 260 &&
            !/\s/.test(text) &&
            !/^[a-z][a-z0-9+.-]*:/i.test(text) &&
            !/^[\\/~]/.test(text) &&
            !text.split(/[\\/]/).includes('..') &&
            (/[\\/]/.test(text) || FILE_EXTENSIONS.has(extension));
        if (!plain) return [];
        files.push(text.replaceAll('\\', '/'));
    }
    return files;
}

export interface RunFile {
    readonly path: string;
    /** Which step handed it in, under which output name. */
    readonly from: string;
}

/** The files the run's steps handed in, first mention first. */
export function runFiles(run: WorkflowRun, root: string): RunFile[] {
    const files = new Map<string, RunFile>();
    for (const step of run.steps) {
        for (const [name, value] of Object.entries(step.outputs)) {
            for (const path of filesIn(value, root)) {
                if (!files.has(path)) files.set(path, { path, from: `${step.title} · ${name}` });
            }
        }
    }
    return [...files.values()];
}

/** The project's absolute path of a file, with the separator the project path uses. */
export function absolutePath(project: Pick<Project, 'path'> | undefined, file: string): string | undefined {
    if (!project) return undefined;
    const windows = project.path.includes('\\') && !project.path.includes('/');
    const separator = windows ? '\\' : '/';
    return `${project.path.replace(/[\\/]+$/, '')}${separator}${windows ? file.replaceAll('/', '\\') : file}`;
}

/**
 * A run's report (06 §22): the outcome, what was done and the next steps. Reports written before have problems
 * instead of a done list.
 */
export interface BriefSections {
    readonly conclusion: string;
    readonly done: readonly string[];
    readonly problems: readonly string[];
    readonly next: readonly string[];
}

const BRIEF_HEADINGS: ReadonlyArray<{ key: keyof BriefSections; pattern: RegExp }> = [
    { key: 'conclusion', pattern: /^(结论|目标达成|目标达成情况|conclusions?|outcome)$/i },
    { key: 'done', pattern: /^(已完成|完成|done|delivered)$/i },
    { key: 'problems', pattern: /^(问题|problems?|issues?)$/i },
    { key: 'next', pattern: /^(下一步|next steps?)$/i },
];

/** A section's list items: bullets and numbered lines, each with its continuation lines; "none" means no items. */
function briefItems(lines: readonly string[]): string[] {
    const items: string[] = [];
    for (const line of lines) {
        const item = /^\s*(?:[-*•]|\d+[.)、])\s+(.*)$/.exec(line);
        if (item) {
            items.push(item[1] ?? '');
        } else if (line.trim() && items.length > 0) {
            items[items.length - 1] = `${items.at(-1)} ${line.trim()}`;
        } else if (line.trim()) {
            items.push(line.trim());
        }
    }
    return items.map((item) => item.trim()).filter((item) => item && !/^(无|没有|none\.?|n\/a)$/i.test(item));
}

/**
 * The three parts of a run's brief, split on its headings (in either language); `undefined` when it has no
 * conclusion heading, so the caller shows the text as it is.
 */
export function briefSections(text: string): BriefSections | undefined {
    const parts: Record<keyof BriefSections, string[]> = { conclusion: [], done: [], problems: [], next: [] };
    let current: keyof BriefSections | undefined;
    let found = false;
    for (const line of text.split(/\r?\n/)) {
        const heading = /^#{1,6}\s*(.+?)\s*#*\s*$/.exec(line)?.[1]?.replace(/[：:]$/, '');
        const known = heading ? BRIEF_HEADINGS.find((item) => item.pattern.test(heading)) : undefined;
        if (known) {
            current = known.key;
            found ||= known.key === 'conclusion';
            continue;
        }
        if (current) parts[current].push(line);
    }
    if (!found) return undefined;
    return {
        conclusion: parts.conclusion.join('\n').trim(),
        done: briefItems(parts.done),
        problems: briefItems(parts.problems),
        next: briefItems(parts.next),
    };
}

/** A step's conclusion in one line: the first sentence of its note or summary, without markdown. */
export function stepGist(step: Pick<WorkflowStepRun, 'note' | 'summary'>, max = 90): string {
    const text = (step.note ?? step.summary ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#>*_`|]/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    const sentence = /^(.+?[。！？!?]|.+?\.(?=\s|$))/.exec(text)?.[1] ?? text;
    return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}
