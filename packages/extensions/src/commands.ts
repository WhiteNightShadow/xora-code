import path from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import { errorMessage, listDir, readText } from './fs-utils.ts';
import type { Diagnostic, ExtensionOrigin, ExtensionSource } from './types.ts';
import { field, firstLine, parseToolList, scalarString, substitute } from './values.ts';

/**
 * Slash commands in the Claude Code style: markdown files whose body is the prompt and whose optional frontmatter
 * has `description`, `argument-hint`, `model` and `allowed-tools`. A file in a subdirectory is namespaced by it:
 * `frontend/build.md` is `/frontend:build`. Plugin commands are prefixed with the plugin name.
 */

export type CommandSource = ExtensionSource;

export interface SlashCommand {
    /** Without the leading slash, e.g. `frontend:build` or `deploy-tools:status`. */
    readonly name: string;
    /** From the frontmatter, or the first line of the body when there is none. */
    readonly description?: string;
    readonly argumentHint?: string;
    readonly model?: string;
    readonly allowedTools?: readonly string[];
    readonly body: string;
    readonly file: string;
    readonly origin: ExtensionOrigin;
    readonly trusted: boolean;
    readonly pluginName?: string;
}

export interface CommandDiscovery {
    readonly commands: readonly SlashCommand[];
    readonly diagnostics: readonly Diagnostic[];
}

/** One segment of a command name: letters (any script), digits, `_`, `.` and `-`, not starting with `.` or `-`. */
const SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;

export function isValidCommandName(name: string): boolean {
    return name.length <= 200 && name.split(':').every((segment) => SEGMENT.test(segment));
}

export interface CommandOverrides {
    readonly description?: string;
    readonly argumentHint?: string;
    readonly model?: string;
    readonly allowedTools?: readonly string[];
}

/**
 * Builds a command from markdown text. `name` is the unprefixed name; plugin sources add their prefix.
 * `overrides` (from a plugin manifest's command map) win over the frontmatter.
 */
export function parseCommand(
    text: string,
    options: {
        readonly name: string;
        readonly file: string;
        readonly source: CommandSource;
        readonly overrides?: CommandOverrides;
    },
): { command?: SlashCommand; diagnostics: Diagnostic[] } {
    const { source, file } = options;
    const diagnostics: Diagnostic[] = [];
    const name = source.pluginName ? `${source.pluginName}:${options.name}` : options.name;
    if (!isValidCommandName(name)) {
        diagnostics.push({ severity: 'error', message: `invalid command name "${name}"`, file });
        return { diagnostics };
    }
    const parsed = parseFrontmatter(text);
    for (const error of parsed.errors) {
        diagnostics.push({ severity: 'warning', message: `line ${error.line}: ${error.message}`, file });
    }
    const { data } = parsed;
    const body =
        source.pluginRoot === undefined
            ? parsed.body
            : substitute(parsed.body, { CLAUDE_PLUGIN_ROOT: source.pluginRoot });
    const overrides = options.overrides ?? {};
    const description =
        overrides.description ?? scalarString(field(data, 'description'))?.trim() ?? firstLine(parsed.body);
    const argumentHint = overrides.argumentHint ?? scalarString(field(data, 'argument-hint', 'argumentHint'));
    const model = overrides.model ?? scalarString(field(data, 'model'));
    const allowedTools = overrides.allowedTools ?? parseToolList(field(data, 'allowed-tools', 'allowedTools'));
    const command: SlashCommand = {
        name,
        ...(description ? { description } : {}),
        ...(argumentHint === undefined ? {} : { argumentHint }),
        ...(model === undefined ? {} : { model }),
        ...(allowedTools === undefined ? {} : { allowedTools }),
        body,
        file,
        origin: source.origin,
        trusted: source.trusted,
        ...(source.pluginName === undefined ? {} : { pluginName: source.pluginName }),
    };
    return { command, diagnostics };
}

/** Reads one command file; `name` defaults to the file name without `.md`. */
export async function loadCommandFile(
    file: string,
    source: CommandSource,
    name = path.basename(file).replace(/\.md$/i, ''),
    overrides?: CommandOverrides,
): Promise<{ command?: SlashCommand; diagnostics: Diagnostic[] }> {
    let text: string;
    try {
        text = await readText(file);
    } catch (error) {
        return { diagnostics: [{ severity: 'error', message: `cannot read command: ${errorMessage(error)}`, file }] };
    }
    return parseCommand(text, { name, file, source, ...(overrides ? { overrides } : {}) });
}

/** Markdown files below `dir` with their namespaced names (`a/b/c.md` is `a:b:c`). Links are not followed. */
async function commandFiles(dir: string): Promise<{ file: string; name: string }[]> {
    const found: { file: string; name: string }[] = [];
    const walk = async (current: string, prefix: string[], depth: number): Promise<void> => {
        for (const entry of await listDir(current)) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && depth < 8) {
                await walk(full, [...prefix, entry.name], depth + 1);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && /\.md$/i.test(entry.name)) {
                found.push({ file: full, name: [...prefix, entry.name.slice(0, -3)].join(':') });
            }
        }
    };
    await walk(dir, [], 0);
    return found;
}

/** Commands in every source directory, in priority order; when names collide the first one wins. */
export async function discoverCommands(sources: readonly CommandSource[]): Promise<CommandDiscovery> {
    const commands: SlashCommand[] = [];
    const diagnostics: Diagnostic[] = [];
    const seen = new Map<string, SlashCommand>();
    for (const source of sources) {
        const files = await commandFiles(source.dir);
        const loaded = await Promise.all(files.map(({ file, name }) => loadCommandFile(file, source, name)));
        for (const { command, diagnostics: found } of loaded) {
            diagnostics.push(...found);
            if (!command) {
                continue;
            }
            const winner = seen.get(command.name);
            if (winner) {
                diagnostics.push({
                    severity: 'info',
                    message: `command "/${command.name}" is shadowed by ${winner.file}`,
                    file: command.file,
                });
                continue;
            }
            seen.set(command.name, command);
            commands.push(command);
        }
    }
    return { commands, diagnostics };
}

/**
 * Splits arguments like a POSIX shell, without expansions: whitespace separates words, single quotes keep text
 * as is, double quotes and backslashes escape. An unclosed quote runs to the end.
 */
export function splitArguments(raw: string): string[] {
    const words: string[] = [];
    let current = '';
    let inWord = false;
    let quote: '"' | "'" | undefined;
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index] ?? '';
        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                current += char;
            }
        } else if (quote === '"') {
            const next = raw[index + 1];
            if (char === '\\' && next !== undefined && '"\\$`'.includes(next)) {
                current += next;
                index++;
            } else if (char === '"') {
                quote = undefined;
            } else {
                current += char;
            }
        } else if (/\s/.test(char)) {
            if (inWord) {
                words.push(current);
                current = '';
                inWord = false;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
            inWord = true;
        } else if (char === '\\' && index + 1 < raw.length) {
            current += raw[index + 1];
            index++;
            inWord = true;
        } else {
            current += char;
            inWord = true;
        }
    }
    if (inWord) {
        words.push(current);
    }
    return words;
}

/**
 * The prompt for running `command` with `rawArgs`:
 * - `$ARGUMENTS` is the whole argument string as typed;
 * - `$1` … `$9` are the shell-style words, from 1; `$ARGUMENTS[N]` is word N counting from 0;
 * - a placeholder without a matching word stays as written, and `\$1` writes a literal `$1`;
 * - when arguments were given but no placeholder took one, they are appended as `ARGUMENTS: <args>`.
 */
export function expandCommand(command: Pick<SlashCommand, 'body'>, rawArgs: string): string {
    const raw = rawArgs.trim();
    const words = splitArguments(raw);
    let used = false;
    const expanded = command.body.replace(
        /(\\?)\$(?:ARGUMENTS\[(\d+)\]|ARGUMENTS\b|([1-9]))/g,
        (match, backslash: string, index: string | undefined, position: string | undefined) => {
            if (backslash) {
                return match.slice(1);
            }
            if (index === undefined && position === undefined) {
                used ||= raw !== '';
                return raw;
            }
            const word = words[index === undefined ? Number(position) - 1 : Number(index)];
            if (word === undefined) {
                return match;
            }
            used = true;
            return word;
        },
    );
    if (raw !== '' && !used) {
        return `${expanded.replace(/\s+$/, '')}\n\nARGUMENTS: ${raw}`;
    }
    return expanded;
}

/** `/name args` → `{ name, args }`; `undefined` for text that is not a slash command, such as `/usr/bin`. */
export function parseSlashInput(text: string): { name: string; args: string } | undefined {
    const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
    const name = match?.[1];
    if (name === undefined || !isValidCommandName(name)) {
        return undefined;
    }
    return { name, args: (match?.[2] ?? '').trim() };
}

/**
 * Looks a command up by name. A bare name also finds a plugin command (`status` → `deploy-tools:status`) when
 * exactly one plugin has it and no other command uses the name.
 */
export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
    const exact = commands.find((command) => command.name === name);
    if (exact || name.includes(':')) {
        return exact;
    }
    const candidates = commands.filter(
        (command) => command.pluginName !== undefined && command.name === `${command.pluginName}:${name}`,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
}
