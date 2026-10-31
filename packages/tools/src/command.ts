/**
 * A conservative reading of shell command lines (bash and POSIX sh syntax) for permission decisions. It splits a line
 * into simple commands and flags the constructs that make a command's effect hard to predict. It is not a parser:
 * syntax it does not model marks the result `incomplete`, and `isReadOnlyCommand` then answers false.
 */

export interface ShellWord {
    /** The word with quotes and escapes removed; expansions such as `$HOME` or `*.ts` are kept as written. */
    readonly value: string;
    /** Whether the shell may still change the word: an unquoted glob or brace, or a `$` or backtick expansion. */
    readonly dynamic: boolean;
}

export interface ShellRedirect {
    /** The operator without its descriptor number: `>`, `>>`, `>|`, `&>`, `&>>`, `>&`, `<`, `<&`, `<>` or `<<<`. */
    readonly operator: string;
    readonly target: ShellWord;
    /** Whether it writes to a file; `/dev/null` and descriptor copies such as `2>&1` do not count. */
    readonly writes: boolean;
}

export interface ShellSegment {
    /** Source text of the simple command, trimmed. */
    readonly text: string;
    /** Command name and arguments, without redirections. */
    readonly words: readonly ShellWord[];
    readonly redirects: readonly ShellRedirect[];
}

export interface ShellSplit {
    /** Simple commands separated by `&&`, `||`, `;`, `|`, `&`, newlines and parentheses. */
    readonly segments: readonly ShellSegment[];
    /** Some redirection writes to a file. */
    readonly hasOutputRedirection: boolean;
    /** Command substitution `$(…)`, backticks, arithmetic `$((…))` or process substitution `<(…)`, `>(…)`. */
    readonly hasSubstitution: boolean;
    /** Subshells and groups: `( … )`, `{ …; }`. */
    readonly hasSubshell: boolean;
    /** Unbalanced quotes or brackets, a here-document, `;;`, or an operator without a command. */
    readonly incomplete: boolean;
}

export interface SplitOptions {
    /**
     * Backslashes are ordinary characters, as in PowerShell and cmd, where they separate the parts of a path. The
     * bash tool runs commands in PowerShell on Windows.
     */
    readonly literalBackslash?: boolean;
}

/** Splits a command line into simple commands and reports the risky syntax it contains. */
export function splitShellCommand(command: string, options: SplitOptions = {}): ShellSplit {
    return new Splitter(command, options.literalBackslash !== true).run();
}

const DISCARD_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

function redirectWrites(operator: string, target: ShellWord): boolean {
    switch (operator) {
        case '>':
        case '>>':
        case '>|':
        case '&>':
        case '&>>':
            return target.dynamic || !DISCARD_TARGETS.has(target.value);
        case '>&':
            // `>&2` copies a descriptor; `>&file` sends stdout and stderr to a file.
            return target.dynamic || !(/^(?:\d+|-)$/.test(target.value) || DISCARD_TARGETS.has(target.value));
        case '<>':
            return true;
        default:
            return false;
    }
}

/** Index of the bracket closing the one at `openIndex`, skipping quoted text; -1 when it is not closed. */
function findClosing(s: string, openIndex: number, open: string, close: string, escapes = true): number {
    let depth = 0;
    for (let i = openIndex; i < s.length; i++) {
        const c = s[i];
        if (escapes && c === '\\') {
            i++;
        } else if (c === "'") {
            const end = s.indexOf("'", i + 1);
            if (end < 0) {
                return -1;
            }
            i = end;
        } else if (c === '"') {
            const end = findQuoteEnd(s, i + 1, '"', escapes);
            if (end < 0) {
                return -1;
            }
            i = end;
        } else if (c === open) {
            depth++;
        } else if (c === close) {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/** Index of the next unescaped `quote` at or after `from`; -1 when there is none. */
function findQuoteEnd(s: string, from: number, quote: string, escapes = true): number {
    for (let i = from; i < s.length; i++) {
        if (escapes && s[i] === '\\') {
            i++;
        } else if (s[i] === quote) {
            return i;
        }
    }
    return -1;
}

class Splitter {
    readonly #source: string;
    /** A backslash escapes the next character (POSIX shells), or is an ordinary one. */
    readonly #escapes: boolean;
    #pos = 0;
    readonly #segments: ShellSegment[] = [];
    #words: ShellWord[] = [];
    #redirects: ShellRedirect[] = [];
    #segmentStart = 0;
    /** After `&&`, `||` or `|`, a command must follow. */
    #needsCommand = false;
    /** The last thing seen closed a group, so an operator may follow without a command of its own. */
    #afterGroup = false;
    #pendingRedirect: string | null = null;

    // The word being read.
    #value = '';
    /** The unquoted characters of the word, where globs and braces take effect. */
    #unquoted = '';
    #inWord = false;
    #dynamic = false;
    #quoted = false;
    #digitsOnly = true;

    #outputRedirection = false;
    #substitution = false;
    #subshell = false;
    #incomplete = false;

    constructor(source: string, escapes: boolean) {
        this.#source = source;
        this.#escapes = escapes;
    }

    run(): ShellSplit {
        const s = this.#source;
        while (this.#pos < s.length && !this.#incomplete) {
            const c = s[this.#pos] ?? '';
            const next = s[this.#pos + 1];
            switch (c) {
                case ' ':
                case '\t':
                    this.#endWord();
                    this.#pos++;
                    break;
                case '\n':
                    this.#endSegment('\n');
                    break;
                case '\\':
                    if (this.#escapes) {
                        this.#escape();
                    } else {
                        this.#literal(c);
                    }
                    break;
                case "'":
                    this.#singleQuoted();
                    break;
                case '"':
                    this.#doubleQuoted();
                    break;
                case '`':
                    this.#backtick();
                    break;
                case '$':
                    this.#dollar();
                    break;
                case '#':
                    if (this.#inWord) {
                        this.#literal(c);
                    } else {
                        const end = s.indexOf('\n', this.#pos);
                        this.#pos = end < 0 ? s.length : end;
                    }
                    break;
                case ';':
                    if (next === ';') {
                        this.#incomplete = true;
                    } else {
                        this.#endSegment(';');
                    }
                    break;
                case '&':
                    if (next === '&') {
                        this.#endSegment('&&');
                    } else if (next === '>') {
                        this.#redirect();
                    } else {
                        this.#endSegment('&');
                    }
                    break;
                case '|':
                    this.#endSegment(next === '|' ? '||' : next === '&' ? '|&' : '|');
                    break;
                case '(':
                case ')':
                    this.#subshell = true;
                    this.#endSegment(c);
                    if (c === ')') {
                        this.#afterGroup = true;
                    }
                    break;
                case '<':
                case '>':
                    this.#redirect();
                    break;
                default:
                    this.#literal(c);
            }
        }
        if (!this.#incomplete) {
            this.#endSegment(null);
        }
        return {
            segments: this.#segments,
            hasOutputRedirection: this.#outputRedirection,
            hasSubstitution: this.#substitution,
            hasSubshell: this.#subshell,
            incomplete: this.#incomplete,
        };
    }

    #literal(c: string): void {
        if (c < '0' || c > '9') {
            this.#digitsOnly = false;
        }
        this.#value += c;
        this.#unquoted += c;
        this.#inWord = true;
        this.#pos++;
    }

    #appendQuoted(text: string): void {
        this.#value += text;
        this.#inWord = true;
        this.#quoted = true;
        this.#digitsOnly = false;
    }

    #escape(): void {
        const next = this.#source[this.#pos + 1];
        if (next === '\n') {
            // Line continuation.
            this.#pos += 2;
        } else if (next === undefined) {
            this.#appendQuoted('\\');
            this.#pos++;
        } else {
            this.#appendQuoted(next);
            this.#pos += 2;
        }
    }

    #singleQuoted(): void {
        const end = this.#source.indexOf("'", this.#pos + 1);
        if (end < 0) {
            this.#incomplete = true;
            return;
        }
        this.#appendQuoted(this.#source.slice(this.#pos + 1, end));
        this.#pos = end + 1;
    }

    #doubleQuoted(): void {
        const s = this.#source;
        let text = '';
        let i = this.#pos + 1;
        while (i < s.length) {
            const c = s[i];
            if (c === '"') {
                this.#appendQuoted(text);
                this.#pos = i + 1;
                return;
            }
            if (c === '\\' && this.#escapes) {
                const next = s[i + 1];
                if (next === '\n') {
                    i += 2;
                } else if (next !== undefined && '$`"\\'.includes(next)) {
                    text += next;
                    i += 2;
                } else {
                    text += c;
                    i++;
                }
            } else if (c === '`') {
                this.#substitution = true;
                this.#dynamic = true;
                const end = findQuoteEnd(s, i + 1, '`', this.#escapes);
                if (end < 0) {
                    break;
                }
                text += s.slice(i, end + 1);
                i = end + 1;
            } else if (c === '$') {
                const end = this.#scanDollar(i, true);
                if (end < 0) {
                    break;
                }
                text += s.slice(i, end);
                i = end;
            } else {
                text += c;
                i++;
            }
        }
        this.#incomplete = true;
    }

    #backtick(): void {
        this.#substitution = true;
        const end = findQuoteEnd(this.#source, this.#pos + 1, '`', this.#escapes);
        if (end < 0) {
            this.#incomplete = true;
            return;
        }
        this.#appendExpansion(end + 1);
    }

    #dollar(): void {
        const end = this.#scanDollar(this.#pos, false);
        if (end < 0) {
            this.#incomplete = true;
            return;
        }
        this.#appendExpansion(end);
    }

    /** Appends the source up to `end` to the current word as it is. */
    #appendExpansion(end: number): void {
        this.#value += this.#source.slice(this.#pos, end);
        this.#inWord = true;
        this.#digitsOnly = false;
        this.#pos = end;
    }

    /** Scans the expansion at the `$` at `start`, sets the flags it implies and returns the index after it (-1: unclosed). */
    #scanDollar(start: number, inDoubleQuotes: boolean): number {
        const s = this.#source;
        const next = s[start + 1];
        if (next === '(') {
            this.#substitution = true;
            this.#dynamic = true;
            const end = findClosing(s, start + 1, '(', ')', this.#escapes);
            return end < 0 ? -1 : end + 1;
        }
        if (next === '{') {
            this.#dynamic = true;
            const end = findClosing(s, start + 1, '{', '}', this.#escapes);
            if (end < 0) {
                return -1;
            }
            if (/\$\(|`|[<>]\(/.test(s.slice(start + 2, end))) {
                this.#substitution = true;
            }
            return end + 1;
        }
        if (!inDoubleQuotes && next === "'") {
            // ANSI-C quoting: its escapes (`\x2d` …) are not decoded here, so the word's value is unknown.
            this.#dynamic = true;
            const end = findQuoteEnd(s, start + 2, "'", this.#escapes);
            return end < 0 ? -1 : end + 1;
        }
        if (!inDoubleQuotes && next === '"') {
            // `$"…"` is a translated string; the quoted part is read as an ordinary double-quoted string next.
            this.#dynamic = true;
            return start + 1;
        }
        if (next !== undefined && /[A-Za-z_]/.test(next)) {
            let end = start + 2;
            while (end < s.length && /[A-Za-z0-9_]/.test(s[end] ?? '')) {
                end++;
            }
            this.#dynamic = true;
            return end;
        }
        if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
            this.#dynamic = true;
            return start + 2;
        }
        return start + 1;
    }

    #redirect(): void {
        const s = this.#source;
        const ahead = s.slice(this.#pos, this.#pos + 3);
        if (ahead.startsWith('<(') || ahead.startsWith('>(')) {
            // Process substitution: an argument naming a pipe to a command.
            this.#substitution = true;
            this.#dynamic = true;
            const end = findClosing(s, this.#pos + 1, '(', ')', this.#escapes);
            if (end < 0) {
                this.#incomplete = true;
                return;
            }
            this.#appendExpansion(end + 1);
            return;
        }
        if (ahead.startsWith('<<') && !ahead.startsWith('<<<')) {
            // A here-document: its body follows on the next lines and is not modelled.
            this.#incomplete = true;
            return;
        }
        // Digits right before the operator name the descriptor it applies to (`2>`); they are not an argument.
        if (this.#inWord && this.#digitsOnly) {
            this.#resetWord();
        } else {
            this.#endWord();
        }
        if (this.#pendingRedirect !== null) {
            this.#incomplete = true;
            return;
        }
        const operators = ['<<<', '&>>', '&>', '>>', '>|', '>&', '<&', '<>', '>', '<'];
        const operator = operators.find((candidate) => ahead.startsWith(candidate)) ?? '>';
        this.#pendingRedirect = operator;
        this.#pos += operator.length;
    }

    #resetWord(): void {
        this.#value = '';
        this.#unquoted = '';
        this.#inWord = false;
        this.#dynamic = false;
        this.#quoted = false;
        this.#digitsOnly = true;
    }

    #endWord(): void {
        if (!this.#inWord) {
            return;
        }
        // Globs (`*`, `?`, `[…]`) and brace expansion (`{a,b}`, `{1..3}`) only act outside quotes.
        const expands = /[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/.test(this.#unquoted);
        const word: ShellWord = { value: this.#value, dynamic: this.#dynamic || expands };
        const group = !this.#quoted && this.#words.length === 0 && (word.value === '{' || word.value === '}');
        this.#resetWord();
        if (this.#pendingRedirect !== null) {
            const writes = redirectWrites(this.#pendingRedirect, word);
            this.#redirects.push({ operator: this.#pendingRedirect, target: word, writes });
            this.#outputRedirection ||= writes;
            this.#pendingRedirect = null;
            return;
        }
        if (group) {
            // `{ …; }` in command position groups commands.
            this.#subshell = true;
            this.#afterGroup = word.value === '}';
            return;
        }
        this.#words.push(word);
        this.#afterGroup = false;
    }

    #endSegment(operator: string | null): void {
        const end = this.#pos;
        this.#endWord();
        if (this.#pendingRedirect !== null) {
            // A redirection operator without a target.
            this.#incomplete = true;
            return;
        }
        if (this.#words.length > 0 || this.#redirects.length > 0) {
            this.#segments.push({
                text: this.#source.slice(this.#segmentStart, end).trim(),
                words: this.#words,
                redirects: this.#redirects,
            });
            this.#words = [];
            this.#redirects = [];
            this.#needsCommand = false;
            this.#afterGroup = false;
        } else if (operator !== null && !['\n', '(', ')'].includes(operator) && !this.#afterGroup) {
            // `;`, `&`, `&&`, `||` and `|` need a command before them.
            this.#incomplete = true;
        }
        if (operator === '&&' || operator === '||' || operator === '|' || operator === '|&') {
            this.#needsCommand = true;
            this.#afterGroup = false;
        }
        if (operator === null && this.#needsCommand) {
            this.#incomplete = true;
        }
        this.#pos += operator?.length ?? 0;
        this.#segmentStart = this.#pos;
    }
}

/**
 * Whether a command line only reads: every simple command in it is on a short list of read-only programs, used with
 * arguments that cannot make it write or run other programs, and nothing redirects output to a file or substitutes
 * commands. Anything uncertain is not read-only.
 *
 * Allowed: `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `cd`, `which`, `type`, `stat`, `du`, `df`, `cut`, `diff`,
 * `grep`/`egrep`/`fgrep`; with argument checks `file` (no `-C`), `tree` (no `-o`), `sort` (no `-o`,
 * `--compress-program`), `uniq` (no output file), `find` (no `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`,
 * `-fls`), `rg` (no `--pre`, `--hostname-bin`), `ag` (no `--pager`); `git` `status`, `diff`, `log`, `show` (no
 * `--output`), `rev-parse`, `ls-files`, `blame`, listing forms of `branch` and `tag`, `remote [-v]`, `--version`; and
 * `node`, `npm`, `pnpm`, `python`, `python3` with only a version flag. Commands with argument checks must not use
 * unquoted globs or expansions, since a file named `-delete` could turn `find . *` into a deletion.
 */
export function isReadOnlyCommand(command: string): boolean {
    const split = splitShellCommand(command);
    if (split.incomplete || split.hasSubstitution || split.hasSubshell || split.hasOutputRedirection) {
        return false;
    }
    return split.segments.length > 0 && split.segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: ShellSegment): boolean {
    const [name, ...args] = segment.words;
    // Paths (`./ls`), assignments (`PAGER=x git log`) and expansions in command position are never trusted.
    if (name === undefined || name.dynamic || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name.value)) {
        return false;
    }
    return READ_ONLY_COMMANDS.get(name.value)?.(args) === true;
}

type ArgCheck = (args: readonly ShellWord[]) => boolean;

/** For programs whose arguments can neither write files nor run other programs. */
const anyArgs: ArgCheck = () => true;

/** For programs with dangerous options: every argument must be literal, then `check` decides. */
const literalArgs =
    (check: (values: readonly string[]) => boolean): ArgCheck =>
    (args) =>
        args.every((arg) => !arg.dynamic) && check(args.map((arg) => arg.value));

const versionOnly =
    (...flags: readonly string[]): ArgCheck =>
    (args) =>
        args.length === 1 && args[0]?.dynamic === false && flags.includes(args[0].value);

/** Whether a cluster of short options such as `-rno` contains one of `letters`. */
const hasShortOption = (values: readonly string[], letters: string): boolean =>
    values.some((value) => /^-[^-]/.test(value) && [...value.slice(1)].some((letter) => letters.includes(letter)));

/**
 * Whether `value` may be the long option `--name`: written in full, abbreviated as getopt and git accept, or longer
 * (`--output-indicator-new`), with or without `=value`. Errs towards yes.
 */
function isLongOption(value: string, name: string): boolean {
    if (!value.startsWith('--')) {
        return false;
    }
    const given = value.slice(2).split('=')[0] ?? '';
    return given.length > 0 && (name.startsWith(given) || given.startsWith(name));
}

const FIND_UNSAFE: ReadonlySet<string> = new Set([
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-delete',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-fls',
]);

/** `uniq [OPTION]... [INPUT [OUTPUT]]`: a second operand is a file it writes. */
function uniqIsReadOnly(values: readonly string[]): boolean {
    let operands = 0;
    let options = true;
    for (let i = 0; i < values.length; i++) {
        const value = values[i] ?? '';
        if (options && value === '--') {
            options = false;
        } else if (options && value.startsWith('--')) {
            if (['--skip-fields', '--skip-chars', '--check-chars'].includes(value)) {
                i++;
            }
        } else if (options && value.startsWith('-') && value !== '-') {
            if (/^-[A-Za-z]*[fsw]$/.test(value)) {
                i++;
            }
        } else {
            operands++;
        }
    }
    return operands <= 1;
}

/** `git diff`, `log`, `show` and friends accept `--output=<file>`. */
const noOutputFile = (values: readonly string[]): boolean => !values.some((value) => isLongOption(value, 'output'));

interface ListingRules {
    /** Options that only change how the list looks; they may also be written `--name=value`. */
    readonly flags: ReadonlySet<string>;
    /** Clusters of short listing options, e.g. `-av`. */
    readonly shortOptions: RegExp;
}

/** Listing filters that take a value, as `--contains <commit>` or `--contains=<commit>`; optional for some. */
const LISTING_VALUE_OPTIONS: ReadonlySet<string> = new Set([
    '--contains',
    '--no-contains',
    '--merged',
    '--no-merged',
    '--points-at',
    '--sort',
    '--format',
]);

/**
 * `git branch` and `git tag` only list when every option is a listing option; names are patterns with `--list` (`-l`)
 * and otherwise create a branch or tag.
 */
function gitListingIsReadOnly(values: readonly string[], rules: ListingRules): boolean {
    let listing = false;
    let names = 0;
    for (let i = 0; i < values.length; i++) {
        const value = values[i] ?? '';
        const option = value.split('=')[0] ?? value;
        if (value === '-l' || value === '--list') {
            listing = true;
        } else if (rules.flags.has(option) || (value.includes('=') && LISTING_VALUE_OPTIONS.has(option))) {
            // Formatting option, or a filter with its value attached.
        } else if (LISTING_VALUE_OPTIONS.has(value)) {
            const following = values[i + 1];
            if (following !== undefined && !following.startsWith('-')) {
                i++;
            }
        } else if (rules.shortOptions.test(value)) {
            listing ||= value.includes('l');
        } else if (value.startsWith('-')) {
            return false;
        } else {
            names++;
        }
    }
    return names === 0 || listing;
}

const BRANCH_LISTING: ListingRules = {
    flags: new Set([
        '--all',
        '--remotes',
        '--verbose',
        '--show-current',
        '--ignore-case',
        '--color',
        '--no-color',
        '--column',
        '--no-column',
        '--abbrev',
        '--no-abbrev',
        '--omit-empty',
    ]),
    shortOptions: /^-[arvil]+$/,
};

const TAG_LISTING: ListingRules = {
    flags: new Set(['--ignore-case', '--color', '--no-color', '--column', '--no-column', '--omit-empty']),
    shortOptions: /^-(?:[il]+|n\d*)$/,
};

const GIT_SUBCOMMANDS: ReadonlyMap<string, (values: readonly string[]) => boolean> = new Map([
    ['status', noOutputFile],
    ['diff', noOutputFile],
    ['log', noOutputFile],
    ['show', noOutputFile],
    ['blame', noOutputFile],
    ['rev-parse', () => true],
    ['ls-files', () => true],
    ['branch', (values: readonly string[]) => gitListingIsReadOnly(values, BRANCH_LISTING)],
    ['tag', (values: readonly string[]) => gitListingIsReadOnly(values, TAG_LISTING)],
    ['remote', (values: readonly string[]) => values.every((value) => value === '-v' || value === '--verbose')],
    ['version', (values: readonly string[]) => values.length === 0],
    ['--version', (values: readonly string[]) => values.length === 0],
]);

/**
 * Global options allowed before the subcommand. `-c`, `--config-env`, `--git-dir`, `--exec-path` and the like are
 * left out: they can make git run arbitrary programs (`core.pager`, `core.fsmonitor`, …).
 */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
    '--no-pager',
    '-P',
    '--no-optional-locks',
    '--literal-pathspecs',
]);

function gitIsReadOnly(values: readonly string[]): boolean {
    let i = 0;
    for (;;) {
        const value = values[i];
        if (value === '-C' && values[i + 1] !== undefined) {
            i += 2;
        } else if (value !== undefined && GIT_GLOBAL_FLAGS.has(value)) {
            i++;
        } else {
            break;
        }
    }
    const subcommand = values[i];
    return subcommand !== undefined && GIT_SUBCOMMANDS.get(subcommand)?.(values.slice(i + 1)) === true;
}

const READ_ONLY_COMMANDS: ReadonlyMap<string, ArgCheck> = new Map([
    ['cat', anyArgs],
    ['cd', anyArgs],
    ['cut', anyArgs],
    ['df', anyArgs],
    ['diff', anyArgs],
    ['du', anyArgs],
    ['echo', anyArgs],
    ['egrep', anyArgs],
    ['fgrep', anyArgs],
    ['grep', anyArgs],
    ['head', anyArgs],
    ['ls', anyArgs],
    ['pwd', anyArgs],
    ['stat', anyArgs],
    ['tail', anyArgs],
    ['type', anyArgs],
    ['wc', anyArgs],
    ['which', anyArgs],
    ['file', literalArgs((values) => !hasShortOption(values, 'C') && !values.some((v) => isLongOption(v, 'compile')))],
    ['tree', literalArgs((values) => !hasShortOption(values, 'o') && !values.some((v) => isLongOption(v, 'output')))],
    [
        'sort',
        literalArgs(
            (values) =>
                !hasShortOption(values, 'o') &&
                !values.some((v) => isLongOption(v, 'output') || isLongOption(v, 'compress-program')),
        ),
    ],
    ['uniq', literalArgs(uniqIsReadOnly)],
    ['find', literalArgs((values) => !values.some((value) => FIND_UNSAFE.has(value)))],
    // ripgrep does not accept abbreviated options; `--pre` and `--hostname-bin` run programs.
    ['rg', literalArgs((values) => !values.some((value) => /^--(?:pre|hostname-bin)(?:=|$)/.test(value)))],
    // ag accepts abbreviations; `--pager` runs a program.
    ['ag', literalArgs((values) => !values.some((value) => value.startsWith('--pa')))],
    ['git', literalArgs(gitIsReadOnly)],
    ['node', versionOnly('--version', '-v')],
    ['npm', versionOnly('--version', '-v')],
    ['pnpm', versionOnly('--version', '-v')],
    ['python', versionOnly('--version', '-V')],
    ['python3', versionOnly('--version', '-V')],
]);
