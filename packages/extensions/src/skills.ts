import path from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import { errorMessage, isFile, listDir, readText, statOrUndefined, walkFiles } from './fs-utils.ts';
import type { Diagnostic, ExtensionOrigin, ExtensionSource } from './types.ts';
import { field, parseToolList, scalarString, stringMap, substitute } from './values.ts';

/**
 * Agent Skills (agentskills.io): a directory with a `SKILL.md` whose frontmatter has `name` and `description`; the
 * body is the instructions and the other files are resources it refers to by relative path. Only name, description
 * and path go into the system prompt; the body is read when the skill is used (progressive disclosure).
 */

export const SKILL_FILE = 'SKILL.md';
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_COMPATIBILITY = 500;

export type SkillSource = ExtensionSource;

export interface Skill {
    readonly name: string;
    /** `<plugin>:<name>` for plugin skills, otherwise the name. Unique within one discovery. */
    readonly id: string;
    readonly description: string;
    readonly dir: string;
    readonly file: string;
    readonly origin: ExtensionOrigin;
    /** Untrusted skills can be read, but their scripts must not be run. */
    readonly trusted: boolean;
    readonly pluginName?: string;
    readonly pluginRoot?: string;
    readonly license?: string;
    readonly compatibility?: string;
    readonly allowedTools?: readonly string[];
    readonly metadata?: Readonly<Record<string, string>>;
}

export interface SkillDiscovery {
    readonly skills: readonly Skill[];
    readonly diagnostics: readonly Diagnostic[];
}

/** 1–64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen. */
export function isValidSkillName(name: string): boolean {
    return name.length <= MAX_SKILL_NAME && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** Reads `<dir>/SKILL.md`. Invalid skills come back as diagnostics only. */
export async function loadSkill(
    dir: string,
    source: SkillSource,
): Promise<{ skill?: Skill; diagnostics: Diagnostic[] }> {
    const file = path.join(dir, SKILL_FILE);
    const diagnostics: Diagnostic[] = [];
    const fail = (message: string): { diagnostics: Diagnostic[] } => {
        diagnostics.push({ severity: 'error', message, file });
        return { diagnostics };
    };
    let text: string;
    try {
        text = await readText(file);
    } catch (error) {
        return fail(`cannot read skill: ${errorMessage(error)}`);
    }
    const parsed = parseFrontmatter(text);
    for (const error of parsed.errors) {
        diagnostics.push({ severity: 'warning', message: `line ${error.line}: ${error.message}`, file });
    }
    if (!parsed.present) {
        return fail('SKILL.md has no frontmatter with name and description');
    }
    const { data } = parsed;
    const dirName = path.basename(dir);
    let name = scalarString(field(data, 'name'))?.trim();
    if (name === undefined || name === '') {
        name = dirName;
        diagnostics.push({ severity: 'warning', message: `no name; using the directory name "${dirName}"`, file });
    }
    if (!isValidSkillName(name)) {
        return fail(
            `invalid skill name "${name}": use 1-${MAX_SKILL_NAME} lowercase letters, digits and single hyphens`,
        );
    }
    if (name !== dirName && isValidSkillName(dirName)) {
        diagnostics.push({
            severity: 'warning',
            message: `name "${name}" differs from its directory "${dirName}"`,
            file,
        });
    }
    const description = scalarString(field(data, 'description'))?.trim();
    if (description === undefined || description === '') {
        return fail(`skill "${name}" has no description`);
    }
    if (description.length > MAX_SKILL_DESCRIPTION) {
        return fail(`description of skill "${name}" is longer than ${MAX_SKILL_DESCRIPTION} characters`);
    }
    const compatibility = scalarString(field(data, 'compatibility'));
    if (compatibility !== undefined && compatibility.length > MAX_SKILL_COMPATIBILITY) {
        diagnostics.push({
            severity: 'warning',
            message: `compatibility is longer than ${MAX_SKILL_COMPATIBILITY} characters`,
            file,
        });
    }
    const license = scalarString(field(data, 'license'));
    const allowedTools = parseToolList(field(data, 'allowed-tools', 'allowedTools'));
    const metadata = stringMap(field(data, 'metadata'));
    const skill: Skill = {
        name,
        id: source.pluginName ? `${source.pluginName}:${name}` : name,
        description,
        dir,
        file,
        origin: source.origin,
        trusted: source.trusted,
        ...(source.pluginName === undefined ? {} : { pluginName: source.pluginName }),
        ...(source.pluginRoot === undefined ? {} : { pluginRoot: source.pluginRoot }),
        ...(license === undefined ? {} : { license }),
        ...(compatibility === undefined ? {} : { compatibility }),
        ...(allowedTools === undefined ? {} : { allowedTools }),
        ...(metadata === undefined ? {} : { metadata }),
    };
    return { skill, diagnostics };
}

/** Skill directories in a source: the source itself when it holds a `SKILL.md`, otherwise its subdirectories. */
export async function skillDirs(dir: string): Promise<string[]> {
    if (await isFile(path.join(dir, SKILL_FILE))) {
        return [dir];
    }
    const dirs: string[] = [];
    for (const entry of await listDir(dir)) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const child = path.join(dir, entry.name);
        // Follow links: skills are often linked in from where they are maintained.
        if ((entry.isDirectory() || entry.isSymbolicLink()) && (await isFile(path.join(child, SKILL_FILE)))) {
            dirs.push(child);
        }
    }
    return dirs;
}

/**
 * Finds skills in `sources`, highest priority first (09 §1: project, user, plugins, built-in). When two skills
 * share an id the first one wins and the other is reported. Missing directories are skipped silently.
 */
export async function discoverSkills(sources: readonly SkillSource[]): Promise<SkillDiscovery> {
    const skills: Skill[] = [];
    const diagnostics: Diagnostic[] = [];
    const seen = new Map<string, Skill>();
    for (const source of sources) {
        const loaded = await Promise.all((await skillDirs(source.dir)).map((dir) => loadSkill(dir, source)));
        for (const { skill, diagnostics: found } of loaded) {
            diagnostics.push(...found);
            if (!skill) {
                continue;
            }
            const winner = seen.get(skill.id);
            if (winner) {
                diagnostics.push({
                    severity: 'info',
                    message: `skill "${skill.id}" is shadowed by ${winner.file}`,
                    file: skill.file,
                });
                continue;
            }
            seen.set(skill.id, skill);
            skills.push(skill);
        }
    }
    return { skills, diagnostics };
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * The skill list for the system prompt: id, description and the path of each `SKILL.md`, nothing else. Empty when
 * there are no skills.
 */
export function renderSkillIndex(skills: readonly Skill[]): string {
    if (skills.length === 0) {
        return '';
    }
    const lines = skills.map((skill) => {
        const note = skill.trusted ? '' : ' [untrusted: read only, do not run its scripts]';
        return `- ${skill.id}: ${oneLine(skill.description)} (${skill.file})${note}`;
    });
    return [
        'Skills are folders of instructions and resources. When a task matches a skill, read its SKILL.md first and follow it; resources are relative to its folder.',
        ...lines,
    ].join('\n');
}

export interface SkillContent {
    /** Instructions with `${CLAUDE_SKILL_DIR}` (and `${CLAUDE_PLUGIN_ROOT}` for plugin skills) filled in. */
    readonly body: string;
    /** Other files of the skill as sorted POSIX paths relative to its directory. */
    readonly resources: readonly string[];
    /** Set when the resource list was cut at `maxResources`. */
    readonly truncated: boolean;
}

/** Reads the full instructions and the resource list of a skill, when it is used. */
export async function readSkill(skill: Skill, options: { readonly maxResources?: number } = {}): Promise<SkillContent> {
    const text = await readText(skill.file);
    const values: Record<string, string> = { CLAUDE_SKILL_DIR: skill.dir };
    if (skill.pluginRoot !== undefined) {
        values.CLAUDE_PLUGIN_ROOT = skill.pluginRoot;
    }
    const body = substitute(parseFrontmatter(text).body, values);
    const max = options.maxResources ?? 200;
    const { files, truncated } = await walkFiles(skill.dir, { maxFiles: max + 1, maxDepth: 6, skipHidden: true });
    const resources = files.filter((file) => file !== SKILL_FILE);
    return {
        body,
        resources: resources.slice(0, max),
        truncated: truncated || resources.length > max,
    };
}

const SCRIPT_EXTENSIONS = new Set([
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.py',
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.mts',
    '.cts',
    '.rb',
    '.pl',
    '.php',
    '.lua',
    '.ps1',
    '.psm1',
    '.bat',
    '.cmd',
    '.exe',
]);

/**
 * Files of a skill that look runnable: anything under a `scripts/` directory, files with a script extension and
 * files with an executable bit. Relative POSIX paths.
 */
export async function findSkillScripts(dir: string): Promise<string[]> {
    const { files } = await walkFiles(dir, { maxFiles: 2000, maxDepth: 8, skipHidden: true });
    const scripts: string[] = [];
    for (const file of files) {
        const segments = file.split('/');
        const runnable =
            segments.slice(0, -1).includes('scripts') || SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase());
        if (runnable) {
            scripts.push(file);
            continue;
        }
        const info = process.platform === 'win32' ? undefined : await statOrUndefined(path.join(dir, ...segments));
        if (info && (info.mode & 0o111) !== 0) {
            scripts.push(file);
        }
    }
    return scripts;
}
