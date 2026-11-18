/**
 * What a model sends is not always what a tool's schema asks for (21 §4.1): `null` for a parameter it leaves out,
 * `"10"` for a number, `file_path` where the tool says `path`, a list as a string of JSON, arguments that are
 * almost JSON. Each of these used to cost a failed call and another request. Here the input is brought into the
 * schema's shape before it is validated, where what the model meant is not in doubt; anything else still fails
 * validation, with the tool's own message.
 */

type Schema = Readonly<Record<string, unknown>>;

/** How models write a tool's input besides the way its schema says; see {@link lenientInput}. */
export interface LenientRules {
    /** Other names for a parameter, by parameter, at any depth of the input. Compared like {@link sameName}. */
    readonly aliases?: Readonly<Record<string, readonly string[]>>;
    /** Other spellings of a parameter's values, by parameter: `{ status: { done: 'completed' } }`. */
    readonly values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** Parameters other harnesses have that this tool does without: dropped without a word. */
    readonly ignore?: readonly string[];
    /** Anything else, on the input as it was sent, before parameters are renamed. */
    readonly adapt?: (input: Record<string, unknown>) => Record<string, unknown>;
    /**
     * Why the input cannot be taken, when taking it would do something other than it says (a `merge` flag on a tool
     * that only replaces); nothing when it can. Asked of the input as it was sent.
     */
    readonly refuse?: (input: Record<string, unknown>) => string | undefined;
}

export interface LenientOptions extends LenientRules {
    /**
     * The schema is the whole truth about the tool (the built-in tools): parameters it does not have are taken out
     * and reported, and an optional parameter sent as an empty string, or as a number below its minimum that is not
     * positive (`offset: 0`), counts as not sent. Without it, what the schema does not describe passes untouched.
     */
    readonly strict?: boolean;
}

export interface LenientInput {
    readonly input: unknown;
    /** Parameters the tool does not have, as sent; only with `strict`, where the schema closes the object. */
    readonly unknown: readonly string[];
    /** Why the call must not run as it was sent (see `LenientRules.refuse`). */
    readonly refused?: string;
}

/** Marks a value that counts as not sent. */
const DROP = Symbol('drop');

/** Parameters some harnesses make models fill in to explain a call; no tool here takes them and none is missed. */
const COMMENTARY: ReadonlySet<string> = new Set([
    'explanation',
    'reason',
    'reasoning',
    'rationale',
    'justification',
    'thought',
    'thoughts',
    'comment',
    'intent',
]);

/**
 * A name without case and separators: `old_string`, `oldString` and `old-string` are the same parameter. Letters and
 * digits of every script count, so that names in Chinese stay apart; a name of signs alone (`!=`) is left with nothing.
 */
function plain(name: string): string {
    return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Whether two names differ only in case and separators. Names with no letter or digit are the same only when equal. */
export function sameName(a: string, b: string): boolean {
    const name = plain(a);
    return a === b || (name !== '' && name === plain(b));
}

/** The one name among `names` that `name` is another spelling of; nothing when it could be several of them. */
function otherSpelling(name: string, names: readonly string[]): string | undefined {
    const same = names.filter((candidate) => sameName(candidate, name));
    return same.length === 1 ? same[0] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Sets a property of its own, whatever the name: `__proto__` from a model's JSON is a parameter like any other. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function tryJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

// Arguments ------------------------------------------------------------------------------------------------------

const ESCAPABLE = '"\\/bfnrtu';
/** Escapes of JSON that a model which writes its backslashes single means as they stand: `\temp`, `\frac`, `\new`. */
const READ_EITHER_WAY = 'bfnrtu';
const WORDS: Readonly<Record<string, string>> = { True: 'true', False: 'false', None: 'null' };
/** What models leave behind a complete value: the end of the tag it was written in, or an end-of-call token. */
const LEFTOVERS = /^(?:\s|<\/[\w:.-]+>|<[|｜][^<>]*[|｜]>)*$/;

/** Whether what follows a complete value takes nothing away from it: nothing, the very same value again, or leftovers. */
function onlyRepeats(value: string, rest: string): boolean {
    let left = rest.trimStart();
    while (left.startsWith(value)) {
        left = left.slice(value.length).trimStart();
    }
    return LEFTOVERS.test(left);
}

/**
 * `text` with the slips of a model writing JSON by hand put right, or nothing when it is not one whole value:
 * line breaks and tabs written raw inside strings, a backslash before a character JSON does not escape (`"\d+"`),
 * a comma before a closing bracket, Python's `True`, `False` and `None`, a code fence around it, and the same value
 * sent twice. Only what reads one way is repaired:
 * - text cut off before its end is never completed;
 * - single backslashes next to escapes that are JSON as well (`"\bfoo\d"`, `"C:\temp\dir"`) are not sorted out: the
 *   model meant `\b` and `\t` literally or it did not, and a pattern, a path or a file is wrong when the guess is;
 * - anything else after the first value (another call's arguments, the rest of a string whose quote was not
 *   escaped) is not dropped.
 */
function repairJson(text: string): string | undefined {
    let source = text.trim();
    const fenced = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(source);
    if (fenced) {
        source = (fenced[1] ?? '').trim();
    }
    let out = '';
    let depth = 0;
    let inString = false;
    /** A backslash that is no escape of JSON was doubled: this model writes them single. */
    let single = false;
    /** An escape was kept that such a model would have meant as it stands. */
    let eitherWay = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i] as string;
        if (inString) {
            if (ch === '\\') {
                const next = source[i + 1];
                if (next === undefined) {
                    return undefined;
                }
                const hex = next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6));
                if (ESCAPABLE.includes(next) && (next !== 'u' || hex)) {
                    eitherWay ||= READ_EITHER_WAY.includes(next);
                    out += ch + next;
                    i++;
                } else {
                    single = true;
                    out += '\\\\';
                }
            } else if (ch === '"') {
                inString = false;
                out += ch;
            } else if (ch === '\n') {
                out += '\\n';
            } else if (ch === '\r') {
                out += '\\r';
            } else if (ch === '\t') {
                out += '\\t';
            } else if (ch < ' ') {
                out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
            } else {
                out += ch;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
        } else if (ch === '{' || ch === '[') {
            depth++;
            out += ch;
        } else if (ch === '}' || ch === ']') {
            out = `${out.replace(/,\s*$/, '')}${ch}`;
            depth--;
            if (depth === 0) {
                const certain = !(single && eitherWay) && onlyRepeats(source.slice(0, i + 1), source.slice(i + 1));
                return certain ? out : undefined;
            }
            if (depth < 0) {
                return undefined;
            }
        } else if (/[A-Za-z]/.test(ch)) {
            const word = /^[A-Za-z]+/.exec(source.slice(i))?.[0] ?? ch;
            out += WORDS[word] ?? word;
            i += word.length - 1;
        } else {
            out += ch;
        }
    }
    return undefined;
}

/**
 * The arguments of a tool call as a value. No arguments at all are an empty object; text that is not JSON is
 * repaired where the repair is certain ({@link repairJson}), and refused otherwise.
 */
export function parseToolArguments(text: string): { readonly ok: true; readonly value: unknown } | { ok: false } {
    if (text.trim() === '') {
        return { ok: true, value: {} };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        // Not JSON as it stands.
    }
    const repaired = repairJson(text);
    if (repaired !== undefined) {
        try {
            return { ok: true, value: JSON.parse(repaired) };
        } catch {
            // Beyond a certain repair.
        }
    }
    return { ok: false };
}

// Input ----------------------------------------------------------------------------------------------------------

function isSchema(value: unknown): value is Schema {
    return isObject(value);
}

/** The schema itself and the alternatives it offers (`anyOf`, `oneOf`). */
function branches(schema: Schema): Schema[] {
    const all = [schema];
    for (const key of ['anyOf', 'oneOf'] as const) {
        const list = schema[key];
        if (Array.isArray(list)) {
            all.push(...list.filter(isSchema));
        }
    }
    return all;
}

/** The JSON types a branch names. */
function namedTypes(branch: Schema): string[] {
    const types = Array.isArray(branch.type) ? branch.type : [branch.type];
    return types.filter((type): type is string => typeof type === 'string');
}

/** JSON types a value of this schema may have; empty when the schema does not say. */
function typesOf(schema: Schema): Set<string> {
    const types = new Set<string>();
    for (const branch of branches(schema)) {
        for (const type of namedTypes(branch)) {
            types.add(type);
        }
        // OpenAPI's way of saying that `null` is a value.
        if (branch.nullable === true) {
            types.add('null');
        }
        const values = Array.isArray(branch.enum) ? branch.enum : 'const' in branch ? [branch.const] : [];
        for (const value of values) {
            types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        }
    }
    return types;
}

/**
 * The values a schema lists, when a string can only be one of them; nothing when an alternative takes any string
 * (`anyOf: [{ enum: ['main'] }, { type: 'string' }]`: `Main` is a value of its own there).
 */
function enumOf(schema: Schema): unknown[] | undefined {
    const listed: unknown[] = [];
    for (const branch of branches(schema)) {
        if (Array.isArray(branch.enum)) {
            listed.push(...branch.enum);
        } else if ('const' in branch) {
            listed.push(branch.const);
        } else if (namedTypes(branch).includes('string') || (branch !== schema && branch.type === undefined)) {
            return undefined;
        }
    }
    return listed.length > 0 ? listed : undefined;
}

/**
 * The branch of a schema that describes an object's properties. Nothing when several do (a union told apart by one
 * of its properties): which of them a value belongs to is the tool's to say, and the value is left as it was sent.
 */
function objectSchema(schema: Schema): Schema | undefined {
    const described = branches(schema).filter((branch) => isObject(branch.properties));
    return described.length === 1 ? described[0] : undefined;
}

/** What a list of this schema holds; nothing when its alternatives say different things. */
function itemSchema(schema: Schema): Schema | undefined {
    const items = branches(schema)
        .map((branch) => branch.items)
        .filter(isSchema);
    return items.length === 1 ? items[0] : undefined;
}

class Normaliser {
    readonly unknown: string[] = [];
    readonly #options: LenientOptions;
    /** Plain alias → parameter. */
    readonly #aliases = new Map<string, string>();
    /** Plain names of parameters that go unmentioned when sent. */
    readonly #ignored: Set<string>;

    constructor(options: LenientOptions) {
        this.#options = options;
        for (const [parameter, names] of Object.entries(options.aliases ?? {})) {
            for (const name of names) {
                if (plain(name) !== '') {
                    this.#aliases.set(plain(name), parameter);
                }
            }
        }
        this.#ignored = new Set([...COMMENTARY, ...(options.ignore ?? []).map(plain)]);
    }

    object(schema: Schema, raw: Record<string, unknown>, where: string): Record<string, unknown> {
        const described = objectSchema(schema);
        const properties = described?.properties;
        if (!described || !isObject(properties)) {
            return raw;
        }
        const required = new Set(Array.isArray(described.required) ? described.required : []);
        const names = Object.keys(properties);
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw)) {
            if (Object.hasOwn(properties, key)) {
                put(out, key, value);
            }
        }
        for (const [key, value] of Object.entries(raw)) {
            if (Object.hasOwn(properties, key)) {
                continue;
            }
            const alias = this.#aliases.get(plain(key));
            const target =
                otherSpelling(key, names) ??
                (alias !== undefined && Object.hasOwn(properties, alias) ? alias : undefined);
            if (target !== undefined) {
                // Sent under its own name as well: that one stands.
                if (!Object.hasOwn(out, target)) {
                    put(out, target, value);
                }
            } else if (!this.#options.strict || described.additionalProperties !== false) {
                // Not this module's to judge: the tool sees it as it was sent.
                put(out, key, value);
            } else if (!this.#ignored.has(plain(key))) {
                this.unknown.push(`${where}${key}`);
            }
        }
        for (const [key, value] of Object.entries(out)) {
            const property = properties[key];
            if (!isSchema(property)) {
                continue;
            }
            const fitted = this.#value(property, value, key, `${where}${key}.`);
            if (fitted === DROP) {
                // Left out when it may be; a `null` for a parameter that has to be there is for the tool to refuse.
                if (!required.has(key)) {
                    delete out[key];
                }
            } else if (!required.has(key) && this.#unset(property, fitted)) {
                delete out[key];
            } else {
                put(out, key, fitted);
            }
        }
        return out;
    }

    /** An optional parameter sent in a way that says "not set" rather than a value; only where `strict`. */
    #unset(schema: Schema, value: unknown): boolean {
        if (!this.#options.strict) {
            return false;
        }
        if (value === '') {
            return true;
        }
        const minimum = branches(schema)
            .map((branch) => branch.minimum)
            .find((bound): bound is number => typeof bound === 'number');
        return typeof value === 'number' && minimum !== undefined && value < minimum && value <= 0;
    }

    #value(schema: Schema, value: unknown, parameter: string, where: string): unknown {
        const types = typesOf(schema);
        if (value === null) {
            return types.size > 0 && !types.has('null') ? DROP : value;
        }
        if (typeof value === 'string') {
            return this.#text(schema, types, value, parameter, where);
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            const numeric = types.has('number') || types.has('integer');
            if (typeof value === 'number' && !numeric && types.has('boolean') && (value === 0 || value === 1)) {
                return value === 1;
            }
            const own = typeof value === 'number' ? numeric : types.has('boolean');
            return !own && types.has('string') ? String(value) : value;
        }
        if (Array.isArray(value)) {
            const items = types.has('array') ? itemSchema(schema) : undefined;
            if (!items) {
                return value;
            }
            return value.map((item, index) => {
                const fitted = this.#value(items, item, parameter, `${where.slice(0, -1)}[${index}].`);
                return fitted === DROP ? item : fitted;
            });
        }
        if (isObject(value)) {
            if (types.has('object')) {
                return this.object(schema, value, where);
            }
            // One item where a list of them is asked for.
            const items = types.has('array') ? itemSchema(schema) : undefined;
            return items && typesOf(items).has('object') ? [this.object(items, value, where)] : value;
        }
        return value;
    }

    #text(schema: Schema, types: Set<string>, value: string, parameter: string, where: string): unknown {
        if (types.has('string')) {
            const allowed = enumOf(schema);
            if (!allowed || allowed.includes(value)) {
                return value;
            }
            const synonym = this.#options.values?.[parameter];
            const named = synonym && Object.entries(synonym).find(([spelling]) => sameName(spelling, value))?.[1];
            if (named !== undefined) {
                return named;
            }
            // The one listed value it is another spelling of. Case and the space around it settle that first, so
            // that `C++` among `c`, `c++` and `c#` is `c++`; then separators, where they leave no choice.
            const listed = allowed.filter((item): item is string => typeof item === 'string');
            const folded = value.trim().toLowerCase();
            const cased = listed.filter((item) => item.toLowerCase() === folded);
            if (cased.length > 0) {
                return cased.length === 1 ? (cased[0] as string) : value;
            }
            return otherSpelling(value, listed) ?? value;
        }
        const trimmed = value.trim();
        if ((types.has('number') || types.has('integer')) && trimmed !== '' && Number.isFinite(Number(trimmed))) {
            const number = Number(trimmed);
            if (types.has('number') || Number.isInteger(number)) {
                return number;
            }
        }
        if (types.has('boolean') && /^(?:true|false)$/i.test(trimmed)) {
            return trimmed.toLowerCase() === 'true';
        }
        if (types.has('array') || types.has('object')) {
            const parsed = tryJson(trimmed);
            if ((Array.isArray(parsed) && types.has('array')) || (isObject(parsed) && types.has('object'))) {
                return this.#value(schema, parsed, parameter, where);
            }
            // One path where a list of them is asked for, for the tools whose lists are known here. An empty string
            // is no item, and a list written as text ("a, b") is not split on a guess.
            const items = this.#options.strict && types.has('array') ? itemSchema(schema) : undefined;
            if (items && typesOf(items).has('string') && trimmed !== '' && !/[,\n]/.test(value)) {
                return [value];
            }
        }
        return value;
    }
}

/**
 * `raw` in the shape `schema` (a JSON Schema) asks for, as far as that takes no guessing:
 * - a parameter under another spelling of its name (`old_string` for `oldString`) or one of its `aliases` is renamed;
 * - `null` where the schema takes none counts as not sent;
 * - a number or boolean written as text, text written as a number, a list or object written as JSON text, one item
 *   where a list is asked for, and an enum value in another case or spelling take the type the schema names;
 * - the whole input as JSON text is read as the object.
 * Values are never invented, a spelling that could be two names or two values is left alone, and what does not fit
 * after this is left for validation to refuse.
 */
export function lenientInput(schema: Schema, raw: unknown, options: LenientOptions = {}): LenientInput {
    let input = raw;
    if (typeof input === 'string') {
        const parsed = tryJson(input.trim());
        if (isObject(parsed)) {
            input = parsed;
        }
    }
    if (!isObject(input)) {
        return { input, unknown: [] };
    }
    const refused = options.refuse?.(input);
    if (refused !== undefined) {
        return { input, unknown: [], refused };
    }
    const normaliser = new Normaliser(options);
    const adapted = options.adapt ? options.adapt({ ...input }) : input;
    return { input: normaliser.object(schema, adapted, ''), unknown: normaliser.unknown };
}

// Tool names -----------------------------------------------------------------------------------------------------

/** What other harnesses call the built-in tools, as plain names (see {@link plain}); only names that mean one tool. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
    readfile: 'read',
    viewfile: 'read',
    view: 'read',
    cat: 'read',
    openfile: 'read',
    writefile: 'write',
    createfile: 'write',
    writetofile: 'write',
    savefile: 'write',
    strreplace: 'edit',
    strreplaceeditor: 'edit',
    strreplacebasededittool: 'edit',
    editfile: 'edit',
    searchreplace: 'edit',
    replaceinfile: 'edit',
    ls: 'list',
    listdir: 'list',
    listdirectory: 'list',
    listfiles: 'list',
    findfiles: 'glob',
    filesearch: 'glob',
    globfiles: 'glob',
    rg: 'grep',
    ripgrep: 'grep',
    grepsearch: 'grep',
    searchfiles: 'grep',
    codesearch: 'grep',
    searchfilecontent: 'grep',
    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    powershell: 'bash',
    terminal: 'bash',
    exec: 'bash',
    execute: 'bash',
    executecommand: 'bash',
    run: 'bash',
    runcommand: 'bash',
    runterminalcmd: 'bash',
    runshellcommand: 'bash',
    runinterminal: 'bash',
    localshell: 'bash',
    killshell: 'bash_kill',
    killbash: 'bash_kill',
    stopjob: 'bash_kill',
    joboutput: 'bash_output',
    jobstatus: 'bash_output',
    checkjob: 'bash_output',
    fetch: 'web_fetch',
    fetchurl: 'web_fetch',
    urlfetch: 'web_fetch',
    openurl: 'web_fetch',
    browse: 'web_fetch',
    searchweb: 'web_search',
    internetsearch: 'web_search',
    googlesearch: 'web_search',
    todowrite: 'todo',
    todoread: 'todo',
    writetodos: 'todo',
    updatetodos: 'todo',
    todos: 'todo',
    updateplan: 'todo',
    patch: 'apply_patch',
    task: 'agent',
    subagent: 'agent',
    delegate: 'agent',
    spawnagent: 'agent',
    dispatchagent: 'agent',
};

/**
 * The tool among `names` a model means by `name`: the name itself, the same name in another case or with other
 * separators (`Read`, `MultiEdit`, `WebFetch`), or what another harness calls it (`run_terminal_cmd`).
 */
export function resolveToolName(name: string, names: Iterable<string>): string | undefined {
    const all = [...names];
    if (all.includes(name)) {
        return name;
    }
    const same = all.filter((candidate) => sameName(candidate, name));
    if (same.length > 0) {
        // Two tools the name could be (`a_b` and `ab` of an MCP server): not for this module to pick.
        return same.length === 1 ? same[0] : undefined;
    }
    const alias = TOOL_ALIASES[plain(name)];
    return alias !== undefined && all.includes(alias) ? alias : undefined;
}
