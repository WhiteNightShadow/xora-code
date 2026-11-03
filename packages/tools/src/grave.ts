import os from 'node:os';
import path from 'node:path';
import { type ShellWord, splitShellCommand } from './command.ts';
import { isPathInside, resolveToolPath } from './path.ts';

/**
 * Grave actions (06 §24): what the user still decides when a supervisor reviews everything else on their behalf.
 * Mass deletion (a delete reaching the system, the home folder or one of its top folders, a workspace as a whole, a
 * path that is nothing but a variable, or many targets at once; erasing a disk) and dropping a database (SQL `DROP`
 * and `TRUNCATE` sent to a database client, `dropdb`, `FLUSHALL`, `dropDatabase()`, framework resets such as
 * `prisma migrate reset`, deleting Docker volumes or database files). It errs towards flagging: a false alarm costs
 * the user one confirmation, a miss can cost their data.
 */

export type GraveAction = 'mass_delete' | 'drop_database';

export interface Grave {
    readonly action: GraveAction;
    /** What gave it away, shortened, for the approval card. */
    readonly what: string;
}

export interface GraveOptions {
    /** Where the command runs. Default: the process's working directory. */
    readonly cwd?: string;
    /** Folders the agent works in; deleting one as a whole is grave. Default: `cwd`. */
    readonly roots?: readonly string[];
    /** For `~`. Default: the user's home directory. */
    readonly home?: string;
}

interface Context {
    readonly cwd: string;
    readonly roots: readonly string[];
    readonly home: string;
}

const MAX_DEPTH = 4;
/** A recursive delete of this many targets at once is mass deletion, wherever they are. */
export const MASS_DELETE_TARGETS = 10;
const LITERAL_BACKSLASH = process.platform === 'win32';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Programs that run the rest of their words as a command. */
const WRAPPERS: ReadonlySet<string> = new Set([
    'sudo',
    'doas',
    'env',
    'nohup',
    'time',
    'nice',
    'command',
    'exec',
    'xargs',
    'timeout',
    'npx',
    'pnpx',
    'bunx',
    'stdbuf',
    'caffeinate',
]);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
const DB_CLIENTS =
    /\b(?:psql|pg_ctl|mysql|mariadb|sqlite3?|duckdb|clickhouse(?:-client)?|cockroach|sqlcmd|mongo|mongosh|redis-cli|cqlsh|snowsql|bq|supabase|turso|planetscale|pscale)\b/i;
const SQL_DROP = /\b(?:drop\s+(?:database|schema|table|keyspace)|truncate\s+(?:table\s+)?["'`\w])/i;
const DB_FILE = /\.(?:db|sqlite3?|mdb|accdb|rdb|ldb)$/i;
const DB_DATA_DIR =
    /(?:^|[\\/])(?:pgdata|postgres(?:ql)?(?:@\d+)?|mysql|mariadb|mongodb?|redis|data[\\/]db)(?:$|[\\/])/i;
const SYSTEM_DIRS = [
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/lib',
    '/lib64',
    '/opt',
    '/private',
    '/proc',
    '/root',
    '/sbin',
    '/srv',
    '/sys',
    '/usr',
    '/var',
    '/System',
    '/Library',
    '/Applications',
    '/Users',
    '/Volumes',
    '/home',
    '/mnt',
    '/media',
];
const WINDOWS_SYSTEM =
    /^[A-Za-z]:[\\/]?(?:$|windows(?:[\\/]|$)|program files|programdata|users(?:[\\/][^\\/]+)?[\\/]?$)/i;

const grave = (action: GraveAction, what: string): Grave => ({
    action,
    what: what.length > 100 ? `${what.slice(0, 100)}…` : what,
});

function programName(value: string): string {
    const base = value.split(/[\\/]/).pop() ?? value;
    return base
        .replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
        .replace(/@.*$/, '')
        .toLowerCase();
}

function shown(words: readonly ShellWord[]): string {
    return words.map((word) => word.value).join(' ');
}

/** The grave action a shell command line takes, if any. */
export function graveOfCommand(command: string, options: GraveOptions = {}): Grave | undefined {
    const cwd = options.cwd ?? process.cwd();
    const context: Context = { cwd, roots: options.roots ?? [cwd], home: options.home ?? os.homedir() };
    return readLine(command, context, 0) ?? rawDatabase(command);
}

/** An MCP tool whose name says it drops or wipes a database, schema, table or collection. */
export function graveOfTool(name: string): Grave | undefined {
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    const words = (match?.[2] ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/);
    const destroys = words.some((word) =>
        ['drop', 'truncate', 'flush', 'wipe', 'purge', 'destroy', 'reset', 'delete', 'remove'].includes(word),
    );
    const store = words.some((word) =>
        ['database', 'databases', 'db', 'schema', 'table', 'tables', 'collection', 'keyspace'].includes(word),
    );
    return destroys && store ? grave('drop_database', name) : undefined;
}

function readLine(line: string, context: Context, depth: number): Grave | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const split = splitShellCommand(line, { literalBackslash: LITERAL_BACKSLASH });
    for (const segment of split.segments) {
        const found = readCommand(segment.words, context, depth);
        if (found) return found;
    }
    if (split.incomplete || split.hasSubstitution) {
        for (const piece of line.split(/[\n;&|()`]/)) {
            const words = piece
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map((word) => {
                    const value = word.replace(/^['"]+|['"]+$/g, '');
                    return { value, dynamic: /[$*?[{]/.test(value) };
                });
            const found = readCommand(words, context, depth);
            if (found) return found;
        }
    }
    return undefined;
}

function readCommand(input: readonly ShellWord[], context: Context, depth: number): Grave | undefined {
    let start = 0;
    while (start < input.length && ASSIGNMENT.test(input[start]?.value ?? '')) start++;
    const head = input[start];
    if (!head || head.value === '') return undefined;
    const name = programName(head.value);
    const args = input.slice(start + 1);
    if (WRAPPERS.has(name)) {
        // The wrapped command starts at the first word that is not an option or a value of one.
        let index = 0;
        while (
            index < args.length &&
            (/^-/.test(args[index]?.value ?? '') ||
                ASSIGNMENT.test(args[index]?.value ?? '') ||
                /^\d+[smhd]?$/.test(args[index]?.value ?? ''))
        ) {
            index++;
        }
        return depth < MAX_DEPTH ? readCommand(args.slice(index), context, depth + 1) : undefined;
    }
    if (SHELLS.has(name)) {
        const script = args.findIndex((arg) => arg.value === '-c' || /^-[a-z]*c$/.test(arg.value));
        const text = script >= 0 ? args[script + 1]?.value : undefined;
        return text ? readLine(text, context, depth + 1) : undefined;
    }
    if (name === 'pnpm' || name === 'yarn' || name === 'bun') {
        const rest =
            args[0]?.value === 'dlx' || args[0]?.value === 'exec' || args[0]?.value === 'x' ? args.slice(1) : args;
        return depth < MAX_DEPTH ? readCommand(rest, context, depth + 1) : undefined;
    }
    switch (name) {
        case 'rm':
        case 'srm':
            return deletes(
                input.slice(start),
                args,
                context,
                (arg) => /^-[A-Za-z]*[rR]/.test(arg) || arg === '--recursive',
            );
        case 'rmdir':
        case 'rd':
        case 'del':
        case 'erase':
        case 'remove-item':
        case 'ri':
            return deletes(input.slice(start), args, context, (arg) => /^(?:\/s|-r(?:ecurse)?)$/i.test(arg));
        case 'find':
            return find(input.slice(start), args, context);
        case 'dd':
            return args.some((arg) => /^of=\/dev\//.test(arg.value)) ? grave('mass_delete', shown(input)) : undefined;
        case 'diskutil':
            return args.some((arg) => /^(?:erase|zero|random|secureerase|reformat|partition)/i.test(arg.value))
                ? grave('mass_delete', shown(input))
                : undefined;
        case 'wipefs':
        case 'format':
            return grave('mass_delete', shown(input));
        case 'dropdb':
            return grave('drop_database', shown(input));
        case 'mysqladmin':
            return args.some((arg) => /^drop$/i.test(arg.value)) ? grave('drop_database', shown(input)) : undefined;
        case 'redis-cli':
            return args.some((arg) => /^flush(?:all|db)$/i.test(arg.value))
                ? grave('drop_database', shown(input))
                : undefined;
        case 'prisma':
            return /\bmigrate\s+reset\b|\bdb\s+push\b.*--force-reset/.test(shown(args))
                ? grave('drop_database', shown(input))
                : undefined;
        case 'rails':
        case 'rake':
            return args.some((arg) => /^db:(?:drop|reset|purge)\b/.test(arg.value))
                ? grave('drop_database', shown(input))
                : undefined;
        case 'django-admin':
            return args.some((arg) => /^(?:flush|reset_db)$/.test(arg.value))
                ? grave('drop_database', shown(input))
                : undefined;
        case 'python':
        case 'python3':
        case 'uv':
        case 'poetry':
            return /\bmanage\.py\s+(?:flush|reset_db)\b/.test(shown(args))
                ? grave('drop_database', shown(input))
                : undefined;
        case 'php':
            return /\bartisan\s+(?:migrate:fresh|migrate:reset|db:wipe)\b/.test(shown(args))
                ? grave('drop_database', shown(input))
                : undefined;
        case 'supabase':
            return /\bdb\s+reset\b/.test(shown(args)) ? grave('drop_database', shown(input)) : undefined;
        case 'docker':
        case 'docker-compose':
        case 'podman':
            return docker(input.slice(start), args);
        case 'ssh':
            return remote(args, depth);
        case 'terraform':
        case 'tofu':
            return args.some((arg) => arg.value === 'destroy') ? grave('mass_delete', shown(input)) : undefined;
        case 'kubectl':
            return /\bdelete\s+(?:namespaces?|ns|pvc?|persistentvolume(?:claim)?s?)\b/.test(shown(args))
                ? grave('mass_delete', shown(input))
                : undefined;
        case 'aws':
            return /\bs3\s+(?:rb\b.*--force|rm\b.*--recursive)/.test(shown(args))
                ? grave('mass_delete', shown(input))
                : undefined;
        case 'gsutil':
            return /\b(?:rm\s+-[a-z]*r|rb)\b/.test(shown(args)) ? grave('mass_delete', shown(input)) : undefined;
        default:
            return undefined;
    }
}

/** `ssh host 'command'`: the command runs on the other machine, where nothing is the workspace. */
function remote(args: readonly ShellWord[], depth: number): Grave | undefined {
    let index = 0;
    while (index < args.length && /^-/.test(args[index]?.value ?? '')) {
        // Options with a value: -p 22, -i key, -l user, -o Option=…, -J jump, -F config…
        index += /^-[bcDEeFIiJLlmOoPpQRSWw]$/.test(args[index]?.value ?? '') ? 2 : 1;
    }
    const text = args
        .slice(index + 1)
        .map((arg) => arg.value)
        .join(' ');
    if (!text || depth >= MAX_DEPTH) return undefined;
    return readLine(text, { cwd: '/root', roots: [], home: '/root' }, depth + 1) ?? rawDatabase(text);
}

/** A delete: grave when it reaches far, wipes a database's files, or takes many targets at once. */
function deletes(
    words: readonly ShellWord[],
    args: readonly ShellWord[],
    context: Context,
    isRecursive: (option: string) => boolean,
): Grave | undefined {
    let recursive = false;
    let options = true;
    const targets: ShellWord[] = [];
    for (const arg of args) {
        if (options && arg.value === '--') {
            options = false;
        } else if (options && !arg.dynamic && /^(?:--?[A-Za-z][\w-]*|\/[A-Za-z])$/.test(arg.value)) {
            if (arg.value === '--no-preserve-root') return grave('mass_delete', shown(words));
            recursive ||= isRecursive(arg.value);
        } else if (arg.value !== '') {
            targets.push(arg);
        }
    }
    for (const target of targets) {
        if (DB_FILE.test(target.value) || (recursive && DB_DATA_DIR.test(target.value))) {
            return grave('drop_database', shown(words));
        }
    }
    if (!recursive) return undefined;
    if (targets.length >= MASS_DELETE_TARGETS) return grave('mass_delete', shown(words));
    return targets.some((target) => farReach(target, context)) ? grave('mass_delete', shown(words)) : undefined;
}

/**
 * Whether a recursive delete of `word` reaches far: the root or a system folder, the home folder, one above it or one
 * of its top folders, a workspace as a whole or its `.git`, everything straight in one of those, or a path that is
 * nothing but a variable (empty, it is `/`).
 */
function farReach(word: ShellWord, context: Context): boolean {
    let value = word.value;
    if (word.dynamic && /^["']?\$\{?\w+\}?["']?(?:[\\/]\*?)?$/.test(value)) return true;
    if (word.dynamic) {
        // A glob: what it starts in, and whether it takes everything there.
        const glob = value.search(/[*?[{]/);
        const fixed = value.slice(0, glob);
        const pattern = value.slice(glob);
        if (/\$/.test(fixed)) return false;
        if (!/^\.?\*+[\\/]?$/.test(pattern)) return false;
        value = fixed === '' ? '.' : fixed;
    }
    if (WINDOWS_SYSTEM.test(value)) return true;
    const target = path.resolve(resolveToolPath(context.cwd, value, context.home));
    const home = path.resolve(context.home);
    const root = path.parse(target).root;
    // The root, a folder straight in it (`/data`, `/srv`), a system folder or one straight in it (`/opt/homebrew`).
    if (target === root || path.dirname(target) === root) return true;
    if (SYSTEM_DIRS.some((dir) => target === dir || path.dirname(target) === dir)) return true;
    if (isPathInside(target, home) || path.dirname(target) === home) return true;
    return context.roots.some((root) => isPathInside(target, root)) || path.basename(target) === '.git';
}

function find(words: readonly ShellWord[], args: readonly ShellWord[], context: Context): Grave | undefined {
    const deletes = args.some(
        (arg, index) =>
            arg.value === '-delete' ||
            (['-exec', '-execdir', '-ok', '-okdir'].includes(arg.value) &&
                ['rm', 'shred', 'unlink'].includes(programName(args[index + 1]?.value ?? ''))),
    );
    if (!deletes) return undefined;
    const filtered = args.some((arg) =>
        /^-(?:i?name|i?path|i?wholename|i?regex|newer\w*|[acm](?:time|min)|size|empty|user|group|perm|links|inum)$/.test(
            arg.value,
        ),
    );
    if (filtered) return undefined;
    const starts: ShellWord[] = [];
    for (const arg of args) {
        if (/^[-(!]/.test(arg.value)) break;
        starts.push(arg);
    }
    if (starts.length === 0) starts.push({ value: '.', dynamic: false });
    return starts.some((start) => farReach(start, context)) ? grave('mass_delete', shown(words)) : undefined;
}

function docker(words: readonly ShellWord[], args: readonly ShellWord[]): Grave | undefined {
    const text = shown(args);
    if (/\bvolume\s+(?:rm|remove|prune)\b/.test(text)) return grave('drop_database', shown(words));
    if (/\b(?:system|volume)\s+prune\b.*--volumes\b/.test(text)) return grave('drop_database', shown(words));
    if (/\bdown\b/.test(text) && args.some((arg) => arg.value === '-v' || arg.value === '--volumes')) {
        return grave('drop_database', shown(words));
    }
    return undefined;
}

/** SQL and database calls the split cannot attribute to a program (here-documents, pipes into a client, `--eval`). */
function rawDatabase(command: string): Grave | undefined {
    const firstLine = command.trim().split('\n')[0] ?? '';
    if (/\.dropDatabase\s*\(|\bdb\.[\w.]+\.drop\s*\(/.test(command)) return grave('drop_database', firstLine);
    if (DB_CLIENTS.test(command) && (SQL_DROP.test(command) || /\bflush(?:all|db)\b/i.test(command))) {
        return grave('drop_database', firstLine);
    }
    return undefined;
}
