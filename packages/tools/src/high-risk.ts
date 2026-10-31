import os from 'node:os';
import path from 'node:path';
import { type ShellWord, splitShellCommand } from './command.ts';
import { isPathInside, resolveToolPath } from './path.ts';

/**
 * High-risk actions (06 §8): pushing, publishing, deleting outside the workspace or broadly, messaging outside the
 * team and payments. A person approves them at every autonomy level and in every permission mode, so this reading
 * errs towards flagging: a false alarm costs one confirmation. It builds on {@link splitShellCommand}, looks through
 * wrappers (`sudo`, `env`, `xargs`, `npx`, `sh -c '…'`, `ssh host '…'`) and reads the raw text again where the split
 * cannot see (here-documents, command substitutions). Commands hidden in scripts, aliases or encoded strings are not
 * found.
 */

/** The actions of `HIGH_RISK_ACTIONS` in `@xora/workflows`. */
export type HighRiskAction = 'push' | 'publish' | 'delete' | 'external_message' | 'payment';

export interface HighRisk {
    readonly action: HighRiskAction;
    /** What gave it away, e.g. `git push` or `rm -rf /tmp/build`. */
    readonly what: string;
}

export interface HighRiskOptions {
    /** Where the command runs; relative paths resolve against it. Default: the process's working directory. */
    readonly cwd?: string;
    /** Folders the agent works in. Deleting outside them, or one of them as a whole, is high risk. Default: `cwd`. */
    readonly roots?: readonly string[];
    /** For `~`. Default: the user's home directory. */
    readonly home?: string;
}

// The bash tool runs commands in PowerShell on Windows, where a backslash separates path parts.
const LITERAL_BACKSLASH = process.platform === 'win32';

interface Context {
    readonly cwd: string;
    readonly roots: readonly string[];
    readonly home: string;
    /** The command runs on another machine (`ssh host …`): nothing there is the workspace. */
    readonly remote: boolean;
}

/** What a program's reader may look into: commands it runs, scripts it is given, commands on another machine. */
interface Reader {
    readonly context: Context;
    command(words: readonly ShellWord[]): HighRisk | undefined;
    line(text: string): HighRisk | undefined;
    remote(text: string): HighRisk | undefined;
}

type ProgramReader = (args: readonly ShellWord[], read: Reader, name: string) => HighRisk | undefined;

const MAX_DEPTH = 6;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that open or continue a compound command in front of the command itself. */
const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'time']);
/** npm, pnpm, yarn, bun, make and the like: scripts and targets that by their name ship something. */
const SHIP_NAME = /^\+?(?:pre|post)?(?:publish|release|deploy|ship)(?:$|[:._-])/i;

/** The high-risk action a shell command line takes, if any. */
export function highRiskOfCommand(command: string, options: HighRiskOptions = {}): HighRisk | undefined {
    const cwd = options.cwd ?? process.cwd();
    const context: Context = { cwd, roots: options.roots ?? [cwd], home: options.home ?? os.homedir(), remote: false };
    return readLine(command, context, 0);
}

function readLine(line: string, context: Context, depth: number): HighRisk | undefined {
    if (depth > MAX_DEPTH) {
        return undefined;
    }
    const split = splitShellCommand(line, { literalBackslash: LITERAL_BACKSLASH });
    for (const segment of split.segments) {
        const found = readCommand(segment.words, context, depth);
        if (found) {
            return found;
        }
    }
    // Here-documents, unbalanced quotes and substitutions hide commands from the split: read the raw text too.
    if (split.incomplete || split.hasSubstitution) {
        for (const piece of line.split(/[\n;&|()`]/)) {
            const found = readCommand(looseWords(piece), context, depth);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

/** Whitespace-separated words with outer quotes removed; anything that may still expand counts as dynamic. */
function looseWords(text: string): ShellWord[] {
    return text
        .trim()
        .split(/\s+/)
        .filter((word) => word !== '')
        .map((word) => {
            const value = word.replace(/^['"]+|['"]+$/g, '');
            return { value, dynamic: /[$*?[{]/.test(value) };
        });
}

function readCommand(input: readonly ShellWord[], context: Context, depth: number): HighRisk | undefined {
    let start = 0;
    while (start < input.length) {
        const value = input[start]?.value ?? '';
        if (!ASSIGNMENT.test(value) && !KEYWORDS.has(value)) {
            break;
        }
        start++;
    }
    const head = input[start];
    if (!head || head.dynamic || head.value === '') {
        return undefined;
    }
    const name = programName(head.value);
    const read: Reader = {
        context,
        command: (words) => (depth < MAX_DEPTH ? readCommand(words, context, depth + 1) : undefined),
        line: (text) => readLine(text, context, depth + 1),
        remote: (text) => readLine(text, { ...context, remote: true }, depth + 1),
    };
    return PROGRAMS.get(name)?.(input.slice(start + 1), read, name);
}

/** `/usr/bin/git` → `git`, `.\gradlew.bat` → `gradlew`, `vercel@latest` → `vercel`. */
function programName(value: string): string {
    const base = value.split(/[\\/]/).at(-1) ?? value;
    return base
        .toLowerCase()
        .replace(/(?<=.)@[^@]*$/, '')
        .replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

const hit = (action: HighRiskAction, what: string): HighRisk => ({ action, what });

/** The command as written, shortened, for the approval card. */
function shown(name: string, args: readonly ShellWord[]): string {
    const text = [name, ...args.map((arg) => arg.value)].join(' ');
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Whether an option is given, as `--name`, `--name=value` or one of the short forms. */
function hasOption(args: readonly ShellWord[], ...names: string[]): boolean {
    return args.some((arg) => names.some((name) => arg.value === name || arg.value.startsWith(`${name}=`)));
}

/** Whether a cluster of short options such as `-fdx` contains `letter`. */
function hasShort(args: readonly ShellWord[], letter: string): boolean {
    return args.some((arg) => /^-[A-Za-z]+$/.test(arg.value) && arg.value.slice(1).includes(letter));
}

/** `--dry-run` rehearses; `-n` means other things to other tools (helm's namespace, poetry's no-interaction). */
const dryRun = (args: readonly ShellWord[]): boolean => hasOption(args, '--dry-run');

/** Index of the first argument that is not an option, skipping the values of `valued` options; -1 if none. */
function firstOperand(args: readonly ShellWord[], valued: ReadonlySet<string> = new Set()): number {
    for (let index = 0; index < args.length; index++) {
        const value = args[index]?.value ?? '';
        if (value === '--') {
            return index + 1 < args.length ? index + 1 : -1;
        }
        if (valued.has(value)) {
            index++;
        } else if (!value.startsWith('-') || value === '-') {
            return index;
        }
    }
    return -1;
}

/** The arguments that are not options, in order. */
function operands(args: readonly ShellWord[], valued: ReadonlySet<string> = new Set()): string[] {
    const found: string[] = [];
    let options = true;
    for (let index = 0; index < args.length; index++) {
        const value = args[index]?.value ?? '';
        if (options && value === '--') {
            options = false;
        } else if (options && valued.has(value)) {
            index++;
        } else if (!options || !value.startsWith('-') || value === '-') {
            found.push(value);
        }
    }
    return found;
}

/** The command after a wrapper's own options. */
function wrapped(args: readonly ShellWord[], valued: ReadonlySet<string> = new Set()): readonly ShellWord[] {
    const index = firstOperand(args, valued);
    return index < 0 ? [] : args.slice(index);
}

/** Words read back as a command line, e.g. the script of `eval` or the remote command of `ssh`. */
function joined(args: readonly ShellWord[]): string {
    return args.map((arg) => arg.value).join(' ');
}

function runner(valued: string[] = []): ProgramReader {
    const set = new Set(valued);
    return (args, read) => read.command(wrapped(args, set));
}

// ---------------------------------------------------------------------------------------------------------
// Deleting

type Reach = 'outside' | 'whole';

function insideRoots(target: string, context: Context): boolean {
    return context.roots.some((root) => isPathInside(root, target));
}

/**
 * How far a delete of `word` reaches: outside every root, or a root as a whole (the root itself, a folder above it,
 * `*` straight in it, its `.git`). Expansions such as `$DIR` are unknown until the command runs, and an empty one
 * turns `rm -rf $DIR/` into `rm -rf /`, so a recursive delete of one counts as reaching everything.
 */
function reachOf(word: ShellWord, context: Context, recursive: boolean): Reach | undefined {
    const value = word.value;
    if (context.remote) {
        return 'outside';
    }
    if (value === '') {
        return undefined;
    }
    if (word.dynamic && /[$`]/.test(value)) {
        return recursive ? 'whole' : undefined;
    }
    if (/^~[^/\\]/.test(value) || (path.sep === '/' && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value))) {
        return 'outside';
    }
    if (word.dynamic) {
        const glob = value.search(/[*?[{]/);
        const fixed = value.slice(0, glob);
        const cut = Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\'));
        const folder = resolveToolPath(context.cwd, cut < 0 ? '.' : fixed.slice(0, cut + 1) || '/', context.home);
        if (!insideRoots(folder, context)) {
            return 'outside';
        }
        const pattern = value.slice(cut + 1);
        return context.roots.some((root) => isPathInside(folder, root)) && /^\.?\*+$/.test(pattern)
            ? 'whole'
            : undefined;
    }
    const target = resolveToolPath(context.cwd, value, context.home);
    if (!insideRoots(target, context)) {
        return 'outside';
    }
    if (context.roots.some((root) => isPathInside(target, root)) || path.basename(target) === '.git') {
        return 'whole';
    }
    return undefined;
}

const rm: ProgramReader = (args, read, name) => {
    let recursive = false;
    let options = true;
    const targets: ShellWord[] = [];
    for (const arg of args) {
        const value = arg.value;
        if (options && value === '--') {
            options = false;
        } else if (options && !arg.dynamic && value.startsWith('--')) {
            if (value === '--no-preserve-root') {
                return hit('delete', shown(name, args));
            }
            recursive ||= value === '--recursive';
        } else if (options && !arg.dynamic && /^-[A-Za-z]+$/.test(value)) {
            recursive ||= /[rR]/.test(value);
        } else {
            targets.push(arg);
        }
    }
    return targets.some((target) => reachOf(target, read.context, recursive))
        ? hit('delete', shown(name, args))
        : undefined;
};

/** `del /s /q x`, `rd /s x`, `Remove-Item -Recurse x`: deletes in Windows shells, whose options start with `/` or `-`. */
const windowsDelete: ProgramReader = (args, read, name) => {
    const recursive = args.some((arg) => /^(?:\/s|-r(?:ecurse)?)$/i.test(arg.value));
    // POSIX rmdir only removes empty folders.
    if ((name === 'rd' || name === 'rmdir') && !recursive) {
        return undefined;
    }
    const targets = args.filter((arg) => !/^\/[A-Za-z]$/.test(arg.value) && !arg.value.startsWith('-'));
    return targets.some((target) => reachOf(target, read.context, recursive))
        ? hit('delete', shown(name, args))
        : undefined;
};

const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_TESTS =
    /^-(?:i?name|i?path|i?wholename|i?regex|type|x?type|newer\w*|[acm](?:time|min)|size|empty|user|group|perm|links|inum|samefile|uid|gid)$/;
const DELETERS: ReadonlySet<string> = new Set(['rm', 'shred', 'unlink', 'srm']);

const find: ProgramReader = (args, read) => {
    const deletes = args.some(
        (arg, index) =>
            arg.value === '-delete' ||
            (FIND_ACTIONS.has(arg.value) && DELETERS.has(programName(args[index + 1]?.value ?? ''))),
    );
    if (!deletes) {
        return undefined;
    }
    let index = 0;
    while (index < args.length && /^-(?:[HLP]|O\d*|D)$/.test(args[index]?.value ?? '')) {
        index += args[index]?.value === '-D' ? 2 : 1;
    }
    const starts: ShellWord[] = [];
    for (; index < args.length; index++) {
        const arg = args[index] as ShellWord;
        if (/^[-(!]/.test(arg.value)) break;
        starts.push(arg);
    }
    if (starts.length === 0) {
        starts.push({ value: '.', dynamic: false });
    }
    const filtered = args.some((arg) => FIND_TESTS.test(arg.value));
    for (const start of starts) {
        const reach = reachOf(start, read.context, true);
        if (reach === 'outside' || (reach === 'whole' && !filtered)) {
            return hit('delete', shown('find', args));
        }
    }
    return undefined;
};

const unlink: ProgramReader = (args, read, name) =>
    args.some((arg) => !arg.value.startsWith('-') && reachOf(arg, read.context, false) === 'outside')
        ? hit('delete', shown(name, args))
        : undefined;

const DISK_ERASERS = /^(?:erasedisk|erasevolume|zerodisk|randomdisk|secureerase|reformat|partitiondisk)$/i;

// ---------------------------------------------------------------------------------------------------------
// Version control and code hosting

const GIT_VALUED: ReadonlySet<string> = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--config-env',
    '--super-prefix',
]);

const git: ProgramReader = (args) => {
    const index = firstOperand(args, GIT_VALUED);
    const subcommand = index < 0 ? undefined : args[index]?.value;
    const rest = index < 0 ? [] : args.slice(index + 1);
    switch (subcommand) {
        case 'push':
            return dryRun(rest) || rest.some((arg) => arg.value === '-n')
                ? undefined
                : hit('push', shown('git push', rest));
        case 'send-email':
            return hit('external_message', 'git send-email');
        case 'svn':
            return rest[0]?.value === 'dcommit' ? hit('push', 'git svn dcommit') : undefined;
        case 'p4':
            return rest[0]?.value === 'submit' ? hit('push', 'git p4 submit') : undefined;
        case 'clean':
            return (hasOption(rest, '--force') || hasShort(rest, 'f')) &&
                !hasOption(rest, '--dry-run') &&
                !hasShort(rest, 'n')
                ? hit('delete', shown('git clean', rest))
                : undefined;
        default:
            return undefined;
    }
};

/** `gh <group> <command>` that change something others see. */
const GH: Readonly<Record<string, Readonly<Record<string, HighRiskAction>>>> = {
    pr: {
        merge: 'push',
        'update-branch': 'push',
        create: 'external_message',
        comment: 'external_message',
        review: 'external_message',
        edit: 'external_message',
        close: 'external_message',
        reopen: 'external_message',
        ready: 'external_message',
        lock: 'external_message',
    },
    issue: {
        create: 'external_message',
        comment: 'external_message',
        edit: 'external_message',
        close: 'external_message',
        reopen: 'external_message',
        transfer: 'external_message',
        lock: 'external_message',
        pin: 'external_message',
        delete: 'delete',
    },
    release: { create: 'publish', upload: 'publish', edit: 'publish', delete: 'delete', 'delete-asset': 'delete' },
    repo: { create: 'publish', edit: 'push', rename: 'push', sync: 'push', archive: 'delete', delete: 'delete' },
    gist: { create: 'publish', edit: 'publish', delete: 'delete' },
    workflow: { run: 'publish' },
    run: { rerun: 'publish', delete: 'delete' },
    secret: { set: 'push', delete: 'delete' },
    variable: { set: 'push', delete: 'delete' },
    label: { delete: 'delete' },
    cache: { delete: 'delete' },
};

const GH_VALUED: ReadonlySet<string> = new Set(['-R', '--repo', '-X', '--method', '-H', '--header', '--hostname']);
const GH_BODY: ReadonlySet<string> = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

const gh: ProgramReader = (args) => {
    const [group, command] = operands(args, GH_VALUED);
    if (group === 'api') {
        let method: string | undefined;
        let body = false;
        let mutation = false;
        for (let index = 0; index < args.length; index++) {
            const value = args[index]?.value ?? '';
            if (value === '-X' || value === '--method') {
                method = args[++index]?.value;
            } else if (/^-X./.test(value) || value.startsWith('--method=')) {
                method = value.replace(/^(?:-X|--method=)/, '');
            } else if (GH_BODY.has(value) || /^--(?:raw-)?field=|^--input=/.test(value)) {
                body = true;
                const field = value.includes('=') ? value : (args[++index]?.value ?? '');
                mutation ||= /\bmutation\b/.test(field);
            }
        }
        if (command === 'graphql') {
            return mutation ? hit('push', 'gh api graphql (mutation)') : undefined;
        }
        const verb = (method ?? (body ? 'POST' : 'GET')).toUpperCase();
        if (verb === 'GET' || verb === 'HEAD') {
            return undefined;
        }
        return hit(verb === 'DELETE' ? 'delete' : 'push', `gh api -X ${verb}`);
    }
    const action = lookup(GH, group, command);
    return action ? hit(action, `gh ${group} ${command}`) : undefined;
};

/** The action of `group command` in a table, own keys only (`constructor` is no command). */
function lookup(
    table: Readonly<Record<string, Readonly<Record<string, HighRiskAction>>>>,
    group: string | undefined,
    command: string | undefined,
): HighRiskAction | undefined {
    const actions = group !== undefined && Object.hasOwn(table, group) ? table[group] : undefined;
    return actions && command !== undefined && Object.hasOwn(actions, command) ? actions[command] : undefined;
}

const GLAB: Readonly<Record<string, Readonly<Record<string, HighRiskAction>>>> = {
    mr: {
        merge: 'push',
        create: 'external_message',
        note: 'external_message',
        update: 'external_message',
        close: 'external_message',
        reopen: 'external_message',
        approve: 'external_message',
        delete: 'delete',
    },
    issue: {
        create: 'external_message',
        note: 'external_message',
        update: 'external_message',
        close: 'external_message',
        reopen: 'external_message',
        delete: 'delete',
    },
    release: { create: 'publish', upload: 'publish', delete: 'delete' },
    repo: { create: 'publish', delete: 'delete', archive: 'delete' },
};

const glab: ProgramReader = (args) => {
    const [group, command] = operands(args, GH_VALUED);
    const action = lookup(GLAB, group, command);
    return action ? hit(action, `glab ${group} ${command}`) : undefined;
};

// ---------------------------------------------------------------------------------------------------------
// Packages and releases

const shipScript = (tool: string, script: string | undefined): HighRisk | undefined =>
    script !== undefined && SHIP_NAME.test(script) ? hit('publish', `${tool} ${script}`) : undefined;

const NPM_VALUED: ReadonlySet<string> = new Set(['-w', '--workspace', '--prefix', '--registry', '--tag', '--otp']);

const npm: ProgramReader = (args, read) => {
    const index = firstOperand(args, NPM_VALUED);
    const command = index < 0 ? undefined : args[index]?.value;
    const rest = index < 0 ? [] : args.slice(index + 1);
    const [first] = operands(rest, NPM_VALUED);
    switch (command) {
        case 'publish':
            return dryRun(args) ? undefined : hit('publish', 'npm publish');
        case 'unpublish':
            return hit('delete', 'npm unpublish');
        case 'deprecate':
        case 'undeprecate':
            return hit('publish', `npm ${command}`);
        case 'dist-tag':
        case 'dist-tags':
        case 'owner':
        case 'access':
            return first === 'add' || first === 'rm' || first === 'set' || first === 'grant' || first === 'revoke'
                ? hit('publish', `npm ${command} ${first}`)
                : undefined;
        case 'run':
        case 'run-script':
        case 'rum':
        case 'urn':
            return shipScript('npm run', first);
        case 'exec':
        case 'x':
            return npx(rest, read, 'npx');
        default:
            return undefined;
    }
};

const PNPM_VALUED: ReadonlySet<string> = new Set(['-F', '--filter', '-C', '--dir', '--reporter', '--loglevel']);
/** pnpm commands; any other first word names a script of the package. */
const PNPM_COMMANDS: ReadonlySet<string> = new Set(
    (
        'add i install update up upgrade remove rm uninstall un link ln unlink import rebuild rb prune fetch patch ' +
        'patch-commit patch-remove audit list ls ll la outdated why licenses run exec test t tst start create dlx init ' +
        'publish pack store env setup deploy doctor config c server root bin recursive multi m approve-builds ' +
        'ignored-builds help dedupe install-test it self-update cat-file cat-index find-hash catalog'
    ).split(' '),
);

const pnpm: ProgramReader = (args, read) => {
    const index = firstOperand(args, PNPM_VALUED);
    const command = index < 0 ? undefined : args[index]?.value;
    const rest = index < 0 ? [] : args.slice(index + 1);
    switch (command) {
        case undefined:
            return undefined;
        case 'publish':
            return dryRun(args) ? undefined : hit('publish', 'pnpm publish');
        case 'run':
            return shipScript('pnpm run', operands(rest, PNPM_VALUED)[0]);
        case 'exec':
        case 'dlx':
            return read.command(wrapped(rest, PNPM_VALUED));
        default:
            return PNPM_COMMANDS.has(command) ? undefined : shipScript('pnpm', command);
    }
};

const YARN_COMMANDS: ReadonlySet<string> = new Set(
    (
        'add install remove upgrade up upgrade-interactive info init link unlink pack publish run workspace ' +
        'workspaces why audit cache config global import licenses list outdated owner policies tag team test ' +
        'unplug version versions bin dedupe constraints explain npm patch plugin rebuild set stage node exec dlx help'
    ).split(' '),
);

const yarn: ProgramReader = (args, read) => {
    const words = operands(args, new Set(['--cwd']));
    // `yarn publish`, `yarn npm publish`, `yarn workspaces foreach … npm publish`.
    if (words.includes('publish')) {
        return dryRun(args) ? undefined : hit('publish', 'yarn publish');
    }
    const [command, next] = words;
    if (command === 'npm' && next === 'tag') {
        return hit('publish', 'yarn npm tag');
    }
    if (command === 'dlx' || command === 'exec') {
        const index = args.findIndex((arg) => arg.value === command);
        return read.command(wrapped(args.slice(index + 1)));
    }
    if (command === 'run') {
        return shipScript('yarn run', next);
    }
    return command !== undefined && !YARN_COMMANDS.has(command) ? shipScript('yarn', command) : undefined;
};

const BUN_COMMANDS: ReadonlySet<string> = new Set(
    (
        'add install i remove rm update outdated link unlink pm build test init create upgrade run x exec repl ' +
        'publish patch audit info why'
    ).split(' '),
);

const bun: ProgramReader = (args, read) => {
    const index = firstOperand(args);
    const command = index < 0 ? undefined : args[index]?.value;
    const rest = index < 0 ? [] : args.slice(index + 1);
    if (command === 'publish') {
        return dryRun(args) ? undefined : hit('publish', 'bun publish');
    }
    if (command === 'x') {
        return read.command(wrapped(rest));
    }
    if (command === 'run') {
        return shipScript('bun run', operands(rest)[0]);
    }
    return command !== undefined && !BUN_COMMANDS.has(command) ? shipScript('bun', command) : undefined;
};

/** `cargo publish`, `poetry publish`, `twine upload`: subcommands that ship something or take it back. */
function subcommands(
    tool: string,
    actions: Readonly<Record<string, HighRiskAction>>,
    options: { readonly valued?: readonly string[]; readonly run?: readonly string[] } = {},
): ProgramReader {
    const valued = new Set(options.valued ?? []);
    return (args, read) => {
        // `cargo +nightly publish`: a toolchain may come first.
        const plain = args.filter((arg) => !arg.value.startsWith('+'));
        const index = firstOperand(plain, valued);
        const command = index < 0 ? undefined : plain[index]?.value;
        if (command === undefined) {
            return undefined;
        }
        if (options.run?.includes(command)) {
            return read.command(wrapped(plain.slice(index + 1), valued));
        }
        const action = Object.hasOwn(actions, command) ? actions[command] : undefined;
        if (!action || (action !== 'delete' && dryRun(args))) {
            return undefined;
        }
        return hit(action, `${tool} ${command}`);
    };
}

/** `pod trunk push`, `dotnet nuget push`: a command group in front of the subcommands. */
function group(name: string, reader: ProgramReader): ProgramReader {
    return (args, read, tool) => {
        const index = firstOperand(args);
        return index >= 0 && args[index]?.value === name ? reader(args.slice(index + 1), read, tool) : undefined;
    };
}

const python: ProgramReader = (args, read) => {
    const module = args.findIndex((arg) => arg.value === '-m');
    if (module >= 0) {
        return read.command(args.slice(module + 1));
    }
    const script = args[0]?.value ?? '';
    return script.endsWith('setup.py') && args.some((arg) => arg.value === 'upload' || arg.value === 'register')
        ? hit('publish', 'setup.py upload')
        : undefined;
};

/** Build tools whose goals or tasks publish: `mvn deploy`, `gradle publish`, `sbt publish`. */
function buildGoals(tool: string, ships: RegExp, local?: RegExp): ProgramReader {
    return (args) => {
        const goal = operands(args).find((value) => ships.test(value) && !local?.test(value));
        return goal ? hit('publish', `${tool} ${goal}`) : undefined;
    };
}

/** `make deploy`, `just release`: targets named like shipping. */
const targets =
    (tool: string): ProgramReader =>
    (args) => {
        const target = operands(args, new Set(['-f', '-C', '--file', '--directory', '--justfile'])).find((value) =>
            SHIP_NAME.test(value),
        );
        return target ? hit('publish', `${tool} ${target}`) : undefined;
    };

// ---------------------------------------------------------------------------------------------------------
// Deployments and infrastructure

const DOCKER_VALUED: ReadonlySet<string> = new Set([
    '-H',
    '--host',
    '-c',
    '--context',
    '--config',
    '-l',
    '--log-level',
]);

const docker: ProgramReader = (args, _read, name) => {
    const words = operands(args, DOCKER_VALUED);
    const [first, second] = words;
    const compose = first === 'compose' || name === 'docker-compose';
    if (
        first === 'push' ||
        (second === 'push' && (first === 'image' || first === 'manifest' || compose)) ||
        ((first === 'build' || first === 'buildx' || first === 'builder' || compose) && hasOption(args, '--push'))
    ) {
        return hit('publish', shown(name, args));
    }
    if (
        (first === 'volume' && (second === 'rm' || second === 'remove' || second === 'prune')) ||
        (first === 'system' && second === 'prune' && hasOption(args, '--volumes')) ||
        (compose && words.includes('down') && (hasOption(args, '--volumes') || hasShort(args, 'v')))
    ) {
        return hit('delete', shown(name, args));
    }
    return undefined;
};

const KUBECTL_CHANGES: ReadonlySet<string> = new Set([
    'apply',
    'create',
    'replace',
    'patch',
    'scale',
    'autoscale',
    'set',
    'edit',
    'annotate',
    'label',
    'expose',
    'run',
    'taint',
]);

const kubectl: ProgramReader = (args, read, name) => {
    const [command, sub] = operands(args, new Set(['-n', '--namespace', '--context', '--kubeconfig', '-f', '-l']));
    if (command === 'exec') {
        const separator = args.findIndex((arg) => arg.value === '--');
        return separator < 0 ? undefined : read.remote(joined(args.slice(separator + 1)));
    }
    if (hasOption(args, '--dry-run')) {
        return undefined;
    }
    if (command === 'delete' || command === 'drain') {
        return hit('delete', `${name} ${command}`);
    }
    if (
        (command !== undefined && KUBECTL_CHANGES.has(command)) ||
        (command === 'rollout' && sub !== undefined && /^(?:restart|undo|pause|resume)$/.test(sub))
    ) {
        return hit('publish', `${name} ${command}`);
    }
    return undefined;
};

const terraform: ProgramReader = (args, _read, name) => {
    const [command] = operands(args, new Set(['-chdir']));
    if (command === 'destroy' || (command === 'apply' && hasOption(args, '-destroy'))) {
        return hit('delete', `${name} destroy`);
    }
    return command === 'apply' ? hit('publish', `${name} apply`) : undefined;
};

const VERCEL_COMMANDS: ReadonlySet<string> = new Set(
    (
        'dev build env link login logout logs pull ls list inspect whoami domains dns certs secrets teams switch help ' +
        'init git project projects bisect open telemetry integration alias'
    ).split(' '),
);

const vercel: ProgramReader = (args) => {
    const [command] = operands(args, new Set(['--scope', '--token', '-t', '--cwd', '-A', '--local-config']));
    if (command === 'rm' || command === 'remove') {
        return hit('delete', 'vercel remove');
    }
    if (command === 'promote' || command === 'redeploy' || command === 'rollback') {
        return hit('publish', `vercel ${command}`);
    }
    // Without a command, or with a folder, vercel deploys.
    return command === undefined || command === 'deploy' || !VERCEL_COMMANDS.has(command)
        ? hit('publish', 'vercel deploy')
        : undefined;
};

const firebase: ProgramReader = (args) => {
    const [first] = operands(args, new Set(['--project', '-P', '--only']));
    if (first === 'deploy' || first?.endsWith(':deploy')) {
        return hit('publish', `firebase ${first}`);
    }
    return first?.endsWith(':delete') ? hit('delete', `firebase ${first}`) : undefined;
};

/** Cloudflare: `wrangler deploy`, `wrangler pages deploy`, `wrangler kv namespace delete`. */
const wrangler: ProgramReader = (args) => {
    const words = operands(args, new Set(['-c', '--config', '-e', '--env']));
    const what = `wrangler ${words.slice(0, 2).join(' ')}`;
    if (words.includes('deploy') || words.includes('publish')) {
        return hit('publish', what);
    }
    return words.includes('delete') ? hit('delete', what) : undefined;
};

/** Cloud CLIs whose command words say what they do: `gcloud run deploy`, `az group delete`. */
const cloud =
    (tool: string): ProgramReader =>
    (args) => {
        const words = operands(args, new Set(['--project', '--region', '--zone', '-g', '--resource-group']));
        if (words.some((word) => /^(?:delete|destroy|remove|purge)(?:$|-)/.test(word))) {
            return hit('delete', `${tool} ${words.slice(0, 3).join(' ')}`);
        }
        return words.includes('deploy') || words.includes('up')
            ? hit('publish', `${tool} ${words.slice(0, 3).join(' ')}`)
            : undefined;
    };

const aws: ProgramReader = (args) => {
    const words = operands(args, new Set(['--profile', '--region', '--endpoint-url', '--output', '--query']));
    const [service, command] = words;
    if (service === undefined || command === undefined) {
        return undefined;
    }
    const what = `aws ${service} ${command}`;
    if (service === 's3' && (command === 'rm' || command === 'rb')) {
        return hit('delete', what);
    }
    if (service === 's3' && /^(?:cp|mv|sync)$/.test(command) && /^s3:\/\//.test(words.at(-1) ?? '')) {
        return hit('publish', what);
    }
    if (/^(?:delete|terminate|remove|deregister|purge)-/.test(command)) {
        return hit('delete', what);
    }
    if ((service === 'ses' || service === 'sesv2') && command.startsWith('send-')) {
        return hit('external_message', what);
    }
    if (service === 'sns' && command === 'publish') {
        return hit('external_message', what);
    }
    return /^(?:deploy|publish-|update-function-code|create-deployment)/.test(command)
        ? hit('publish', what)
        : undefined;
};

// ---------------------------------------------------------------------------------------------------------
// Network

const LOCAL_HOST = /^(?:localhost|.+\.localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i;
const PAYMENT_HOST =
    /(?:^|\.)(?:stripe\.com|paypal\.com|braintreegateway\.com|adyen\.com|squareup\.com|alipay\.com|mch\.weixin\.qq\.com|checkout\.com|razorpay\.com|mollie\.com|paddle\.com|lemonsqueezy\.com|wise\.com)$/i;

function hostOf(url: string): string | undefined {
    try {
        return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname;
    } catch {
        return undefined;
    }
}

/** A request that sends data (or deletes): to a payment API, to anyone outside this machine. */
function sends(tool: string, method: string, urls: readonly string[]): HighRisk | undefined {
    const verb = method.toUpperCase();
    if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') {
        return undefined;
    }
    const hosts = urls.map(hostOf);
    if (hosts.length > 0 && hosts.every((host) => host !== undefined && LOCAL_HOST.test(host))) {
        return undefined;
    }
    const host = hosts.find((candidate) => candidate !== undefined && !LOCAL_HOST.test(candidate)) ?? '?';
    if (hosts.some((candidate) => candidate !== undefined && PAYMENT_HOST.test(candidate))) {
        return hit('payment', `${tool} ${verb} ${host}`);
    }
    return hit(verb === 'DELETE' ? 'delete' : 'external_message', `${tool} ${verb} ${host}`);
}

const CURL_DATA = /^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form(?:-string)?|-T|--upload-file)$/;
const CURL_VALUED: ReadonlySet<string> = new Set(
    (
        '-H --header -o --output -u --user -A --user-agent -e --referer -b --cookie -c --cookie-jar -w --write-out ' +
        '-m --max-time --connect-timeout -x --proxy -K --config --cacert --cert --key -r --range --retry -E -U ' +
        '--proxy-user --resolve --interface -Y -y --limit-rate --mail-from'
    ).split(' '),
);

const curl: ProgramReader = (args) => {
    let method: string | undefined;
    let body = false;
    const urls: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const value = args[index]?.value ?? '';
        if (value === '-X' || value === '--request') {
            method = args[++index]?.value;
        } else if (/^-X[A-Za-z]/.test(value) || value.startsWith('--request=')) {
            method = value.replace(/^(?:-X|--request=)/, '');
        } else if (value === '--mail-rcpt' || value.startsWith('--mail-rcpt=')) {
            return hit('external_message', 'curl --mail-rcpt');
        } else if (CURL_DATA.test(value)) {
            body = true;
            index++;
        } else if (/^(?:-d|-F|-T).|^--(?:data[a-z-]*|json|form[a-z-]*|upload-file)=/.test(value)) {
            body = true;
        } else if (value === '--url') {
            urls.push(args[++index]?.value ?? '');
        } else if (CURL_VALUED.has(value)) {
            index++;
        } else if (/^-[A-Za-z]{2,}$/.test(value)) {
            // Short options may be clustered: in `-sSd '{…}'` the last one takes the next word.
            const last = value.at(-1) ?? '';
            if (last === 'X') {
                method = args[++index]?.value;
            } else if ('dFT'.includes(last)) {
                body = true;
                index++;
            } else if (CURL_VALUED.has(`-${last}`)) {
                index++;
            }
        } else if (!value.startsWith('-')) {
            urls.push(value);
        }
    }
    if (urls.some((url) => /^smtps?:\/\//i.test(url))) {
        return hit('external_message', 'curl smtp');
    }
    return sends('curl', method ?? (body ? 'POST' : 'GET'), urls);
};

const wget: ProgramReader = (args) => {
    const method = args.find((arg) => arg.value.startsWith('--method='))?.value.slice(9);
    const body = hasOption(args, '--post-data', '--post-file', '--body-data', '--body-file');
    const urls = operands(args, new Set(['-O', '-o', '-a', '-P', '-U', '--header', '-e', '-t', '-T']));
    return sends('wget', method ?? (body ? 'POST' : 'GET'), urls);
};

const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;

/** HTTPie and xh: `http [METHOD] URL [items]`; data items make it a POST. */
const httpie: ProgramReader = (args, _read, name) => {
    const words = operands(args, new Set(['-a', '--auth', '--session', '-o', '--output', '--verify', '--cert']));
    const explicit = words[0] !== undefined && HTTP_METHOD.test(words[0]) ? words[0] : undefined;
    const url = explicit ? words[1] : words[0];
    const items = words.slice(explicit ? 2 : 1);
    const data = hasOption(args, '--form', '-f') || items.some((item) => /^[^=:@]+(?::=|=(?!=)|@)/.test(item));
    return url ? sends(name, explicit ?? (data ? 'POST' : 'GET'), [url]) : undefined;
};

/** `scp a host:b`, `rsync dist/ host:/srv`: copying to another machine. */
const REMOTE_PATH = /^(?:rsync:\/\/|(?![A-Za-z]:[\\/])[^/\\:]+:)/;

const scp: ProgramReader = (args, _read, name) => {
    const words = operands(args, new Set(['-P', '-p', '-i', '-F', '-o', '-c', '-l', '-J', '-S']));
    const destination = words.length >= 2 ? words.at(-1) : undefined;
    return destination && REMOTE_PATH.test(destination) ? hit('publish', `${name} → ${destination}`) : undefined;
};

const rsync: ProgramReader = (args, read) => {
    const words = operands(args, new Set(['-e', '--rsh', '-f', '--filter', '--port', '-T', '--temp-dir', '-B']));
    const destination = words.length >= 2 ? words.at(-1) : undefined;
    if (!destination) {
        return undefined;
    }
    if (REMOTE_PATH.test(destination)) {
        return hit('publish', `rsync → ${destination}`);
    }
    const deletes = args.some((arg) => /^--(?:delete|remove-source-files)/.test(arg.value));
    return deletes && reachOf({ value: destination, dynamic: false }, read.context, true)
        ? hit('delete', shown('rsync', args))
        : undefined;
};

const SSH_VALUED: ReadonlySet<string> = new Set(
    '-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w -B'.split(' '),
);

const ssh: ProgramReader = (args, read) => {
    const index = firstOperand(args, SSH_VALUED);
    const command = index < 0 ? '' : joined(args.slice(index + 1));
    return command.trim() === '' ? undefined : read.remote(command);
};

/** Mail clients send when they are given a recipient. */
const mailer: ProgramReader = (args, _read, name) =>
    operands(args, new Set(['-s', '-c', '-b', '-r', '-a', '-A', '-S', '-f'])).length > 0
        ? hit('external_message', name)
        : undefined;

const stripe: ProgramReader = (args) => {
    const words = operands(args, new Set(['--api-key', '-d', '--data', '--project-name', '-p']));
    const charges = words.some((word) => /^(?:create|confirm|capture|pay|refund|void|finalize)$/.test(word));
    if (words[0] === 'post' || words[0] === 'trigger' || charges) {
        return hit('payment', `stripe ${words.slice(0, 2).join(' ')}`);
    }
    return words.includes('delete') ? hit('delete', `stripe ${words.slice(0, 2).join(' ')}`) : undefined;
};

// ---------------------------------------------------------------------------------------------------------
// Wrappers and interpreters

/** `sh -c 'script'`, `bash -lc "…"`; a script file is not read. */
const shell: ProgramReader = (args, read) => {
    let command = false;
    for (const arg of args) {
        const value = arg.value;
        if (value === '--') {
            return undefined;
        }
        if (/^[-+][A-Za-z]+$/.test(value)) {
            command ||= value.slice(1).includes('c');
        } else if (value.startsWith('--')) {
            // --login, --norc and the like.
        } else {
            return command ? read.line(value) : undefined;
        }
    }
    return undefined;
};

const powershell: ProgramReader = (args, read) => {
    const index = args.findIndex((arg) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(arg.value));
    return index < 0 ? undefined : read.line(joined(args.slice(index + 1)));
};

const cmd: ProgramReader = (args, read) => {
    const index = args.findIndex((arg) => /^\/[ck]$/i.test(arg.value));
    return index < 0 ? undefined : read.line(joined(args.slice(index + 1)));
};

const env: ProgramReader = (args, read) => {
    for (let index = 0; index < args.length; index++) {
        const value = args[index]?.value ?? '';
        if (value === '-S' || value === '--split-string') {
            return read.line(joined(args.slice(index + 1)));
        }
        if (value === '-u' || value === '--unset' || value === '-C' || value === '--chdir') {
            index++;
        } else if (!value.startsWith('-') && !ASSIGNMENT.test(value)) {
            return read.command(args.slice(index));
        }
    }
    return undefined;
};

const command: ProgramReader = (args, read) =>
    args.some((arg) => arg.value === '-v' || arg.value === '-V') ? undefined : read.command(wrapped(args));

const timeout: ProgramReader = (args, read) => {
    const rest = wrapped(args, new Set(['-s', '--signal', '-k', '--kill-after']));
    return read.command(rest.slice(1));
};

const XARGS_VALUED: ReadonlySet<string> = new Set(
    '-I -L -n -P -s -d -E -a --arg-file --delimiter --max-args --max-procs --max-chars --replace'.split(' '),
);

/** The command gets more arguments from the input, unknown here: `xargs rm -rf` deletes whatever comes in. */
const xargs: ProgramReader = (args, read) =>
    read.command([...wrapped(args, XARGS_VALUED), { value: '$INPUT', dynamic: true }]);

/** `npx vercel deploy`, `npx -p np np`: the package's command. */
const npx: ProgramReader = (args, read) => {
    const script = args.findIndex((arg) => arg.value === '-c' || arg.value === '--call');
    if (script >= 0) {
        return read.line(args[script + 1]?.value ?? '');
    }
    return read.command(wrapped(args, new Set(['-p', '--package'])));
};

const eval_: ProgramReader = (args, read) => read.line(joined(args));

/** Release tools that publish unless told to rehearse. */
const releaser =
    (needs?: string): ProgramReader =>
    (args, _read, name) => {
        if (needs !== undefined && !operands(args).includes(needs)) {
            return undefined;
        }
        return dryRun(args) ? undefined : hit('publish', needs ? `${name} ${needs}` : name);
    };

// ---------------------------------------------------------------------------------------------------------

const always =
    (action: HighRiskAction): ProgramReader =>
    (args, _read, name) =>
        hit(action, shown(name, args));

const PROGRAMS: ReadonlyMap<string, ProgramReader> = new Map<string, ProgramReader>([
    // Deleting
    ['rm', rm],
    ['find', find],
    ['unlink', unlink],
    ['shred', always('delete')],
    ['srm', always('delete')],
    ['wipefs', always('delete')],
    ['del', windowsDelete],
    ['erase', windowsDelete],
    ['rd', windowsDelete],
    ['rmdir', windowsDelete],
    ['remove-item', windowsDelete],
    ['ri', windowsDelete],
    [
        'dd',
        (args) => (args.some((arg) => /^of=\/dev\//.test(arg.value)) ? hit('delete', shown('dd', args)) : undefined),
    ],
    [
        'diskutil',
        (args) =>
            args.some((arg) => DISK_ERASERS.test(arg.value)) ? hit('delete', shown('diskutil', args)) : undefined,
    ],
    // Version control and code hosting
    ['git', git],
    ['gh', gh],
    ['glab', glab],
    // Packages and releases
    ['npm', npm],
    ['pnpm', pnpm],
    ['yarn', yarn],
    ['bun', bun],
    ['deno', subcommands('deno', { publish: 'publish', deploy: 'publish' }, { run: ['run'] })],
    ['jsr', subcommands('jsr', { publish: 'publish' })],
    ['cargo', subcommands('cargo', { publish: 'publish', yank: 'delete' })],
    ['twine', subcommands('twine', { upload: 'publish', register: 'publish' })],
    ['poetry', subcommands('poetry', { publish: 'publish' }, { run: ['run'] })],
    ['uv', subcommands('uv', { publish: 'publish' }, { run: ['run'], valued: ['--with', '--python', '-p'] })],
    ['pdm', subcommands('pdm', { publish: 'publish' }, { run: ['run'] })],
    ['hatch', subcommands('hatch', { publish: 'publish' }, { run: ['run'] })],
    ['flit', subcommands('flit', { publish: 'publish' })],
    ['gem', subcommands('gem', { push: 'publish', yank: 'delete' })],
    ['pod', group('trunk', subcommands('pod trunk', { push: 'publish', delete: 'delete' }))],
    ['dotnet', group('nuget', subcommands('dotnet nuget', { push: 'publish', delete: 'delete' }))],
    ['nuget', subcommands('nuget', { push: 'publish', delete: 'delete' })],
    ['python', python],
    ['python3', python],
    ['py', python],
    ['mvn', buildGoals('mvn', /(?:^|:)(?:deploy(?:-file)?|perform)$/)],
    ['mvnw', buildGoals('mvnw', /(?:^|:)(?:deploy(?:-file)?|perform)$/)],
    ['gradle', buildGoals('gradle', /(?:^|:)(?:publish\w*|upload\w*)$/, /publishToMavenLocal$/)],
    ['gradlew', buildGoals('gradlew', /(?:^|:)(?:publish\w*|upload\w*)$/, /publishToMavenLocal$/)],
    ['sbt', buildGoals('sbt', /^\+?(?:publish|publishSigned|release)$/)],
    ['make', targets('make')],
    ['just', targets('just')],
    ['task', targets('task')],
    ['rake', targets('rake')],
    ['np', releaser()],
    ['semantic-release', releaser()],
    ['release-it', releaser()],
    ['changeset', releaser('publish')],
    ['lerna', releaser('publish')],
    ['nx', releaser('release')],
    // Deployments and infrastructure
    ['docker', docker],
    ['podman', docker],
    ['nerdctl', docker],
    ['docker-compose', docker],
    ['kubectl', kubectl],
    ['oc', kubectl],
    [
        'helm',
        subcommands('helm', {
            push: 'publish',
            install: 'publish',
            upgrade: 'publish',
            uninstall: 'delete',
            delete: 'delete',
        }),
    ],
    ['terraform', terraform],
    ['tofu', terraform],
    ['terragrunt', terraform],
    ['pulumi', subcommands('pulumi', { up: 'publish', update: 'publish', destroy: 'delete' })],
    ['vercel', vercel],
    ['vc', vercel],
    ['netlify', subcommands('netlify', { deploy: 'publish', 'sites:delete': 'delete' })],
    ['ntl', subcommands('netlify', { deploy: 'publish', 'sites:delete': 'delete' })],
    ['firebase', firebase],
    ['fly', subcommands('fly', { deploy: 'publish', launch: 'publish', destroy: 'delete' })],
    ['flyctl', subcommands('flyctl', { deploy: 'publish', launch: 'publish', destroy: 'delete' })],
    ['wrangler', wrangler],
    ['railway', subcommands('railway', { up: 'publish', down: 'delete' })],
    ['heroku', subcommands('heroku', { 'apps:destroy': 'delete', destroy: 'delete' })],
    ['aws', aws],
    ['gcloud', cloud('gcloud')],
    ['az', cloud('az')],
    // Network and messages
    ['curl', curl],
    ['wget', wget],
    ['http', httpie],
    ['https', httpie],
    ['xh', httpie],
    ['xhs', httpie],
    ['scp', scp],
    ['rsync', rsync],
    ['ssh', ssh],
    ['mail', mailer],
    ['mailx', mailer],
    ['s-nail', mailer],
    ['mutt', mailer],
    ['neomutt', mailer],
    ['sendmail', always('external_message')],
    ['msmtp', always('external_message')],
    ['ssmtp', always('external_message')],
    ['swaks', always('external_message')],
    [
        'twilio',
        (args) =>
            operands(args).some((word) => /:(?:messages|calls):create$/.test(word))
                ? hit('external_message', 'twilio create')
                : undefined,
    ],
    ['stripe', stripe],
    // Wrappers and interpreters
    ['sh', shell],
    ['bash', shell],
    ['zsh', shell],
    ['dash', shell],
    ['ksh', shell],
    ['mksh', shell],
    ['ash', shell],
    ['fish', shell],
    ['pwsh', powershell],
    ['powershell', powershell],
    ['cmd', cmd],
    ['eval', eval_],
    ['env', env],
    ['command', command],
    ['builtin', runner()],
    ['exec', runner(['-a'])],
    ['nohup', runner()],
    ['nice', runner(['-n', '--adjustment'])],
    ['ionice', runner(['-c', '-n', '-t'])],
    ['sudo', runner(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-U', '-D', '-R'])],
    ['doas', runner(['-u', '-C'])],
    ['timeout', timeout],
    ['stdbuf', runner(['-i', '-o', '-e'])],
    ['caffeinate', runner(['-t', '-w'])],
    ['chronic', runner()],
    ['unbuffer', runner()],
    ['watch', runner(['-n', '--interval'])],
    ['xargs', xargs],
    ['npx', npx],
    ['pnpx', npx],
    ['bunx', npx],
    ['uvx', runner(['--from', '--with', '--python'])],
    [
        'pipx',
        (args, read) =>
            operands(args)[0] === 'run'
                ? read.command(wrapped(args.slice(args.findIndex((arg) => arg.value === 'run') + 1)))
                : undefined,
    ],
]);

// ---------------------------------------------------------------------------------------------------------
// MCP tools

const READ_VERBS: ReadonlySet<string> = new Set(
    (
        'get list search read fetch query find view describe retrieve show count lookup look check export download ' +
        'browse inspect preview status info whoami ping validate analyze analyse summarize summarise explain diff ' +
        'compare resolve watch poll subscribe screenshot snapshot render navigate'
    ).split(' '),
);
const DELETE_VERBS: ReadonlySet<string> = new Set(
    'delete remove destroy drop purge erase wipe trash unpublish truncate'.split(' '),
);
const PUSH_VERBS: ReadonlySet<string> = new Set(['push', 'merge', 'force']);
const PUBLISH_VERBS: ReadonlySet<string> = new Set(['publish', 'release', 'deploy', 'ship']);
const MESSAGE_VERBS: ReadonlySet<string> = new Set(
    'send post reply tweet retweet notify broadcast email mail message dm forward comment mention invite'.split(' '),
);
const WRITE_VERBS: ReadonlySet<string> = new Set(
    'create add write submit update edit new make put set upload insert schedule open close reopen place'.split(' '),
);
const MESSAGE_WORDS: ReadonlySet<string> = new Set(
    (
        'message messages email emails mail sms comment comments reply issue issues pull pr review tweet post posts ' +
        'discussion notification invitation'
    ).split(' '),
);
const PAYMENT_WORDS: ReadonlySet<string> = new Set(
    (
        'pay payment payments charge charges refund refunds payout payouts checkout purchase buy invoice invoices ' +
        'subscription subscriptions order orders transfer transfers'
    ).split(' '),
);
/** Repository hosts, where writing a file, branch or commit is a push. */
const CODE_HOST = /git|bitbucket|forge/i;
const REPOSITORY_WORDS: ReadonlySet<string> = new Set(['file', 'files', 'commit', 'commits', 'branch', 'ref', 'tag']);

/**
 * The high-risk action an MCP tool's name announces, e.g. `mcp__github__merge_pull_request` (push),
 * `mcp__slack__slack_post_message` (external message) or `mcp__stripe__create_refund` (payment). Tools whose verb
 * reads (`get_…`, `list_…`) are never flagged. Names are all there is: the server's own hints are not trusted.
 */
export function highRiskOfTool(name: string): HighRisk | undefined {
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    if (!match?.[1] || !match[2]) {
        return undefined;
    }
    const words = match[2]
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== '');
    const verb = words.find(
        (word) =>
            READ_VERBS.has(word) ||
            DELETE_VERBS.has(word) ||
            PUSH_VERBS.has(word) ||
            PUBLISH_VERBS.has(word) ||
            MESSAGE_VERBS.has(word) ||
            WRITE_VERBS.has(word),
    );
    if (verb === undefined || READ_VERBS.has(verb)) {
        return undefined;
    }
    const mentions = (list: ReadonlySet<string>) => words.some((word) => list.has(word));
    if (mentions(PAYMENT_WORDS)) {
        return hit('payment', name);
    }
    if (DELETE_VERBS.has(verb)) {
        return hit('delete', name);
    }
    if (PUSH_VERBS.has(verb) || (CODE_HOST.test(match[1]) && mentions(REPOSITORY_WORDS))) {
        return hit('push', name);
    }
    if (PUBLISH_VERBS.has(verb)) {
        return hit('publish', name);
    }
    if (MESSAGE_VERBS.has(verb) || mentions(MESSAGE_WORDS)) {
        return hit('external_message', name);
    }
    return undefined;
}
