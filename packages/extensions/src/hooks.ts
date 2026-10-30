import { z } from 'zod';
import { errorCode, errorMessage, readText } from './fs-utils.ts';
import { runProcess, shellInvocation } from './process.ts';
import type { Diagnostic, ExtensionOrigin } from './types.ts';
import { isPlainObject, substitute } from './values.ts';

/**
 * Lifecycle hooks in the Claude Code settings format (09 §4):
 * `{"hooks": {"PreToolUse": [{"matcher": "Bash|Edit", "hooks": [{"type": "command", "command": "…"}]}]}}`.
 * Command hooks get the event as JSON on stdin; exit 0 may print a JSON decision, exit 2 blocks with stderr as the
 * reason, other exit codes are non-blocking errors. `http` hooks POST the same JSON and answer in the same shape.
 * Hooks from untrusted sources are never run.
 */

export const HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'Stop',
    'SubagentStop',
    'Notification',
    'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Events whose matcher applies, and to what: the tool name for tool events, otherwise the session start source,
 * compaction trigger, end reason, notification type or agent type.
 */
export const MATCHER_EVENTS: ReadonlySet<HookEvent> = new Set([
    'PreToolUse',
    'PostToolUse',
    'SessionStart',
    'PreCompact',
    'SessionEnd',
    'Notification',
    'SubagentStop',
]);

/**
 * Events a hook can block or redirect: deny a tool call, reject a prompt, keep the agent working instead of
 * stopping. For PostToolUse the tool already ran, so a block becomes feedback for the model.
 */
export const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set([
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'Stop',
    'SubagentStop',
]);

/** Events whose plain-text stdout (exit 0, not JSON) is added as context. */
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(['UserPromptSubmit', 'SessionStart']);

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
/** Longest per-hook `timeout`, in seconds. */
export const MAX_HOOK_TIMEOUT_SECONDS = 3600;

const TimeoutSchema = z.number().positive().max(MAX_HOOK_TIMEOUT_SECONDS);
const OnFailureSchema = z.enum(['continue', 'block']);

export const CommandHookSchema = z.object({
    type: z.literal('command'),
    /** Shell command line, or the program when `args` is set. */
    command: z.string().min(1),
    /** Exec form: run `command` with these arguments and no shell. */
    args: z.array(z.string()).optional(),
    /** Seconds. */
    timeout: TimeoutSchema.optional(),
    /** `block` turns a failed, timed-out or unparsable run into a block. Default `continue`. */
    onFailure: OnFailureSchema.optional(),
    statusMessage: z.string().optional(),
});

/** Xora extension: POST the event JSON to `url`; the response body uses the command hook output format. */
export const HttpHookSchema = z.object({
    type: z.literal('http'),
    url: z.url({ protocol: /^https?$/ }),
    /** `$NAME` and `${NAME}` in values are filled from the hook environment for names in `allowedEnvVars`. */
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    timeout: TimeoutSchema.optional(),
    onFailure: OnFailureSchema.optional(),
    statusMessage: z.string().optional(),
});

export const HookHandlerSchema = z.discriminatedUnion('type', [CommandHookSchema, HttpHookSchema]);

export const HookMatcherGroupSchema = z.object({
    /** Regex over the target, or `|`/`,`-separated exact names; empty or `*` matches everything. */
    matcher: z.string().optional(),
    hooks: z.array(HookHandlerSchema),
});

export const HookEventMapSchema = z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherGroupSchema));

/** Strict schema of a hooks file. {@link loadHookConfigs} is lenient and skips what it does not support instead. */
export const HookConfigSchema = z.object({ hooks: HookEventMapSchema });

export type CommandHook = z.infer<typeof CommandHookSchema>;
export type HttpHook = z.infer<typeof HttpHookSchema>;
export type HookHandler = z.infer<typeof HookHandlerSchema>;
export type HookEventMap = z.infer<typeof HookEventMapSchema>;

/** Where a set of hooks was declared. */
export interface HookSource {
    /** The settings, `hooks.json` or `plugin.json` file. */
    readonly path: string;
    readonly origin: ExtensionOrigin;
    readonly trusted: boolean;
    readonly pluginName?: string;
    /** Substituted for `${CLAUDE_PLUGIN_ROOT}` and exported as `CLAUDE_PLUGIN_ROOT` when the hook runs. */
    readonly pluginRoot?: string;
}

export interface HookGroup {
    readonly event: HookEvent;
    readonly matcher: string;
    readonly hooks: readonly HookHandler[];
}

/** The hooks of one file, as written: placeholders are filled in when they run. */
export interface HookConfig {
    readonly source: HookSource;
    readonly groups: readonly HookGroup[];
}

export interface MatchedHook {
    readonly event: HookEvent;
    readonly matcher: string;
    readonly handler: HookHandler;
    readonly source: HookSource;
}

const SIMPLE_MATCHER = /^[A-Za-z0-9_\- ,|]*$/;
const matcherCache = new Map<string, (target: string) => boolean>();

/**
 * Compiles a matcher as Claude Code does: empty or `*` matches everything; letters, digits, `_`, `-`, spaces, `,`
 * and `|` only means exact names (`Edit|Write` does not match `NotebookEdit`); anything else is an unanchored
 * regular expression. Throws for an invalid expression.
 */
export function compileMatcher(matcher: string): (target: string) => boolean {
    const cached = matcherCache.get(matcher);
    if (cached) {
        return cached;
    }
    const trimmed = matcher.trim();
    let test: (target: string) => boolean;
    if (trimmed === '' || trimmed === '*') {
        test = () => true;
    } else if (SIMPLE_MATCHER.test(trimmed)) {
        const names = new Set(
            trimmed
                .split(/[|,]/)
                .map((name) => name.trim())
                .filter((name) => name !== ''),
        );
        test = (target) => names.has(target);
    } else {
        const pattern = new RegExp(trimmed);
        test = (target) => pattern.test(target);
    }
    matcherCache.set(matcher, test);
    return test;
}

function isEventName(name: string): name is HookEvent {
    return (HOOK_EVENTS as readonly string[]).includes(name);
}

/**
 * Reads an event map (`{"PreToolUse": [...]}`) or a whole hooks object (`{"hooks": {...}}`). Unknown events,
 * unsupported handler types and invalid entries are skipped with a diagnostic; the rest is kept.
 */
export function parseHookConfig(value: unknown, source: HookSource): { config: HookConfig; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const file = source.path;
    const groups: HookGroup[] = [];
    const config = (): { config: HookConfig; diagnostics: Diagnostic[] } => ({
        config: { source, groups },
        diagnostics,
    });
    let events = value;
    if (isPlainObject(events) && isPlainObject(events.hooks) && !Object.keys(events).some(isEventName)) {
        events = events.hooks;
    }
    if (!isPlainObject(events)) {
        diagnostics.push({ severity: 'error', message: 'hooks must be an object of events', file });
        return config();
    }
    for (const [event, entries] of Object.entries(events)) {
        if (!isEventName(event)) {
            diagnostics.push({ severity: 'warning', message: `unsupported hook event "${event}" ignored`, file });
            continue;
        }
        if (!Array.isArray(entries)) {
            diagnostics.push({ severity: 'error', message: `hooks.${event} must be a list`, file });
            continue;
        }
        for (const [index, entry] of entries.entries()) {
            const where = `hooks.${event}[${index}]`;
            if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
                diagnostics.push({ severity: 'error', message: `${where} needs a "hooks" list`, file });
                continue;
            }
            const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
            try {
                compileMatcher(matcher);
            } catch (error) {
                diagnostics.push({
                    severity: 'error',
                    message: `${where}: invalid matcher: ${errorMessage(error)}`,
                    file,
                });
                continue;
            }
            const handlers: HookHandler[] = [];
            for (const [position, raw] of entry.hooks.entries()) {
                const type = isPlainObject(raw) ? raw.type : undefined;
                if (type !== 'command' && type !== 'http') {
                    diagnostics.push({
                        severity: 'warning',
                        message: `${where}.hooks[${position}]: unsupported hook type "${String(type)}" ignored`,
                        file,
                    });
                    continue;
                }
                const parsed = HookHandlerSchema.safeParse(raw);
                if (!parsed.success) {
                    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
                    diagnostics.push({
                        severity: 'error',
                        message: `${where}.hooks[${position}]: ${detail.join('; ')}`,
                        file,
                    });
                    continue;
                }
                handlers.push(parsed.data);
            }
            if (handlers.length > 0) {
                groups.push({ event, matcher, hooks: handlers });
            }
        }
    }
    return config();
}

/** A settings or hooks file to read hooks from. */
export type HookFile = HookSource;

/**
 * Reads the `hooks` of each file, in order. Files that do not exist or have no `hooks` key are skipped silently;
 * unreadable ones are reported.
 */
export async function loadHookConfigs(
    files: readonly HookFile[],
): Promise<{ configs: HookConfig[]; diagnostics: Diagnostic[] }> {
    const configs: HookConfig[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const file of files) {
        let json: unknown;
        try {
            json = JSON.parse(await readText(file.path));
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') {
                diagnostics.push({
                    severity: 'error',
                    message: `cannot read hooks: ${errorMessage(error)}`,
                    file: file.path,
                });
            }
            continue;
        }
        if (!isPlainObject(json)) {
            diagnostics.push({ severity: 'error', message: 'expected a JSON object', file: file.path });
            continue;
        }
        if (!('hooks' in json) && !Object.keys(json).some(isEventName)) {
            continue;
        }
        const parsed = parseHookConfig('hooks' in json ? json.hooks : json, file);
        diagnostics.push(...parsed.diagnostics);
        configs.push(parsed.config);
    }
    return { configs, diagnostics };
}

function dedupeKey(handler: HookHandler, source: HookSource): string {
    const scope = `${source.trusted ? 't' : 'u'}\0${source.pluginRoot ?? ''}`;
    return handler.type === 'command'
        ? `command\0${scope}\0${handler.command}\0${JSON.stringify(handler.args ?? null)}`
        : `http\0${scope}\0${handler.url}`;
}

/**
 * Hooks to run for `event`, in configuration order, with identical handlers removed. `target` is what the matcher
 * is tested against (see {@link MATCHER_EVENTS}); groups with a specific matcher do not match when it is absent.
 * Untrusted hooks are included so that {@link runHooks} can report them as skipped.
 */
export function matchHooks(configs: readonly HookConfig[], event: HookEvent, target?: string): MatchedHook[] {
    const matched: MatchedHook[] = [];
    const seen = new Set<string>();
    for (const config of configs) {
        for (const group of config.groups) {
            if (group.event !== event) {
                continue;
            }
            if (MATCHER_EVENTS.has(event)) {
                let test: (value: string) => boolean;
                try {
                    test = compileMatcher(group.matcher);
                } catch {
                    continue;
                }
                const everything = group.matcher.trim() === '' || group.matcher.trim() === '*';
                if (!everything && (target === undefined || !test(target))) {
                    continue;
                }
            }
            for (const handler of group.hooks) {
                const key = dedupeKey(handler, config.source);
                if (!seen.has(key)) {
                    seen.add(key);
                    matched.push({ event, matcher: group.matcher, handler, source: config.source });
                }
            }
        }
    }
    return matched;
}

/** JSON a hook may print on exit 0 or return from an HTTP call; unknown fields are ignored. */
export interface HookOutput {
    /** `false` stops the agent after this event, whatever else the hooks decided. */
    readonly continue?: boolean;
    readonly stopReason?: string;
    readonly suppressOutput?: boolean;
    /** Shown to the user. */
    readonly systemMessage?: string;
    /** `block` blocks (for PreToolUse the legacy `approve`/`block` mean allow/deny). */
    readonly decision?: string;
    readonly reason?: string;
    readonly hookSpecificOutput?: {
        readonly hookEventName?: string;
        readonly permissionDecision?: string;
        readonly permissionDecisionReason?: string;
        readonly additionalContext?: string;
        readonly updatedInput?: Readonly<Record<string, unknown>>;
    };
}

export type HookDecision = 'allow' | 'ask' | 'deny';

export interface HookRunResult {
    readonly hook: MatchedHook;
    /** Exit code of a command hook; `null` for HTTP hooks, skipped hooks and processes that did not exit. */
    readonly exitCode: number | null;
    /** HTTP status of an http hook. */
    readonly status?: number;
    readonly durationMs: number;
    /** stdout, or the response body of an http hook. */
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    /** Set when the hook failed in a non-blocking way: did not start, timed out, exit code other than 0 and 2, bad HTTP status or unparsable output. */
    readonly error?: string;
    readonly skipped?: 'untrusted';
    /** The parsed JSON output, when the hook printed one. */
    readonly output?: HookOutput;
}

export interface HooksOutcome {
    /** A hook blocked the action (only for {@link BLOCKING_EVENTS}). */
    readonly blocked: boolean;
    /** Why, joined from every blocking hook. */
    readonly reason?: string;
    /** Strongest permission decision of the hooks: deny > ask > allow. A block counts as deny. */
    readonly decision?: HookDecision;
    /** Context to add for the model, joined from every hook. */
    readonly additionalContext?: string;
    /** A hook returned `continue: false`: stop the agent. Overrides `blocked`. */
    readonly stop: boolean;
    readonly stopReason?: string;
    /** Messages for the user: `systemMessage` values and stderr of blocks on events that cannot block. */
    readonly messages: readonly string[];
    /** Replacement tool input from a PreToolUse hook (the last one wins). */
    readonly updatedInput?: Readonly<Record<string, unknown>>;
    readonly results: readonly HookRunResult[];
}

export interface RunHooksOptions {
    readonly cwd: string;
    /**
     * Environment of hook processes, already stripped of secrets by the caller; nothing is read from this
     * process. Also the source of `allowedEnvVars` header values.
     */
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    /** Timeout for hooks that set none. Default {@link DEFAULT_HOOK_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** Project root for `${CLAUDE_PROJECT_DIR}`; defaults to `cwd`. */
    readonly projectDir?: string;
    /** Cap for each captured stream or response body. Default 1 MiB. */
    readonly maxOutputBytes?: number;
}

function shellQuote(value: string): string {
    return /^[A-Za-z0-9_/.:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Fills `${NAME}` placeholders in a shell command line, quoting each value for where it stands: inside single
 * quotes, inside double quotes or bare. A path with spaces therefore stays one word even when the placeholder
 * was written without quotes.
 */
export function substituteShellCommand(
    command: string,
    values: Readonly<Record<string, string>>,
    platform: NodeJS.Platform = process.platform,
): string {
    let out = '';
    let quote: '"' | "'" | undefined;
    for (let index = 0; index < command.length; ) {
        const char = command[index] ?? '';
        const placeholder = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(command.slice(index));
        const name = placeholder?.[1];
        if (placeholder && name !== undefined && Object.hasOwn(values, name)) {
            const value = values[name] ?? '';
            if (platform === 'win32') {
                out += quote === undefined && /[\s&|<>^()]/.test(value) ? `"${value}"` : value;
            } else if (quote === '"') {
                out += value.replace(/["$`\\]/g, '\\$&');
            } else if (quote === "'") {
                out += value.replaceAll("'", `'\\''`);
            } else {
                out += shellQuote(value);
            }
            index += placeholder[0].length;
            continue;
        }
        if (char === '\\' && quote !== "'" && platform !== 'win32') {
            out += command.slice(index, index + 2);
            index += 2;
            continue;
        }
        if (quote === undefined && (char === '"' || (char === "'" && platform !== 'win32'))) {
            quote = char;
        } else if (char === quote) {
            quote = undefined;
        }
        out += char;
        index++;
    }
    return out;
}

function placeholderValues(hook: MatchedHook, options: RunHooksOptions): Record<string, string> {
    const values: Record<string, string> = { CLAUDE_PROJECT_DIR: options.projectDir ?? options.cwd };
    if (hook.source.pluginRoot !== undefined) {
        values.CLAUDE_PLUGIN_ROOT = hook.source.pluginRoot;
    }
    return values;
}

/** The program and arguments a command hook runs, with placeholders filled in. */
export function resolveHookCommand(
    handler: CommandHook,
    values: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string | undefined>> = {},
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
    if (handler.args !== undefined) {
        return {
            file: substitute(handler.command, values),
            args: handler.args.map((arg) => substitute(arg, values)),
            windowsVerbatimArguments: false,
        };
    }
    return shellInvocation(substituteShellCommand(handler.command, values), env);
}

function parseOutput(text: string): { output?: HookOutput; invalid?: boolean } {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
        return {};
    }
    try {
        const json: unknown = JSON.parse(trimmed);
        return isPlainObject(json) ? { output: json as HookOutput } : { invalid: true };
    } catch {
        return { invalid: true };
    }
}

function timeoutOf(handler: HookHandler, options: RunHooksOptions): number {
    return handler.timeout === undefined ? (options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS) : handler.timeout * 1000;
}

async function runCommandHook(
    hook: MatchedHook,
    handler: CommandHook,
    input: string,
    options: RunHooksOptions,
): Promise<HookRunResult> {
    const values = placeholderValues(hook, options);
    const env = { ...options.env, ...values };
    const { file, args, windowsVerbatimArguments } = resolveHookCommand(handler, values, env);
    const timeoutMs = timeoutOf(handler, options);
    const result = await runProcess(file, args, {
        cwd: options.cwd,
        env,
        input,
        timeoutMs,
        windowsVerbatimArguments,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });
    let error: string | undefined;
    let output: HookOutput | undefined;
    if (result.spawnError !== undefined) {
        error = `could not start: ${result.spawnError}`;
    } else if (result.timedOut) {
        error = `timed out after ${timeoutMs} ms`;
    } else if (result.aborted) {
        error = 'aborted';
    } else if (result.exitCode === 0) {
        const parsed = parseOutput(result.stdout);
        output = parsed.output;
        if (parsed.invalid) {
            error = 'stdout is not a JSON object';
        }
    } else if (result.exitCode !== 2) {
        error = result.exitCode === null ? 'killed' : `exit code ${result.exitCode}`;
    }
    return {
        hook,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        ...(error === undefined ? {} : { error }),
        ...(output === undefined ? {} : { output }),
    };
}

function headerValues(handler: HttpHook, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const allowed = new Set(handler.allowedEnvVars ?? []);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(handler.headers ?? {})) {
        headers[name] = value.replace(
            /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
            (_match, braced: string | undefined, bare: string | undefined) => {
                const key = braced ?? bare ?? '';
                return allowed.has(key) ? (env[key] ?? '') : '';
            },
        );
    }
    return headers;
}

async function readBody(response: Response, limit: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        return '';
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (size + value.byteLength > limit) {
            chunks.push(value.subarray(0, limit - size));
            await reader.cancel();
            break;
        }
        chunks.push(value);
        size += value.byteLength;
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function runHttpHook(
    hook: MatchedHook,
    handler: HttpHook,
    input: string,
    options: RunHooksOptions,
): Promise<HookRunResult> {
    const started = performance.now();
    const timeoutMs = timeoutOf(handler, options);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
        controller.abort();
    }
    let status: number | undefined;
    let body = '';
    let error: string | undefined;
    let output: HookOutput | undefined;
    try {
        const response = await fetch(handler.url, {
            method: 'POST',
            headers: { ...headerValues(handler, options.env), 'content-type': 'application/json' },
            body: input,
            signal: controller.signal,
            // A redirect would forward the event to another server.
            redirect: 'manual',
        });
        status = response.status;
        body = await readBody(response, options.maxOutputBytes ?? 1024 * 1024);
        if (status < 200 || status >= 300) {
            error = `HTTP ${status}`;
        } else if (body.trim() !== '') {
            const parsed = parseOutput(body);
            output = parsed.output;
            if (!parsed.output) {
                error = 'response is not a JSON object';
            }
        }
    } catch (caught) {
        error = timedOut
            ? `timed out after ${timeoutMs} ms`
            : options.signal?.aborted
              ? 'aborted'
              : `request failed: ${errorMessage(caught)}`;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
    return {
        hook,
        exitCode: null,
        ...(status === undefined ? {} : { status }),
        durationMs: Math.round(performance.now() - started),
        stdout: body,
        stderr: '',
        timedOut,
        ...(error === undefined ? {} : { error }),
        ...(output === undefined ? {} : { output }),
    };
}

async function runHook(hook: MatchedHook, input: string, options: RunHooksOptions): Promise<HookRunResult> {
    if (!hook.source.trusted) {
        return { hook, exitCode: null, durationMs: 0, stdout: '', stderr: '', timedOut: false, skipped: 'untrusted' };
    }
    return hook.handler.type === 'command'
        ? runCommandHook(hook, hook.handler, input, options)
        : runHttpHook(hook, hook.handler, input, options);
}

const DECISION_RANK: Readonly<Record<HookDecision, number>> = { allow: 1, ask: 2, deny: 3 };

function aggregate(event: HookEvent, results: readonly HookRunResult[]): HooksOutcome {
    const reasons: string[] = [];
    const contexts: string[] = [];
    const messages: string[] = [];
    let blocked = false;
    let decision: HookDecision | undefined;
    let stop = false;
    let stopReason: string | undefined;
    let updatedInput: Readonly<Record<string, unknown>> | undefined;
    const raise = (next: HookDecision): void => {
        if (decision === undefined || DECISION_RANK[next] > DECISION_RANK[decision]) {
            decision = next;
        }
    };
    const block = (reason: string): void => {
        if (BLOCKING_EVENTS.has(event)) {
            blocked = true;
            reasons.push(reason);
            raise('deny');
        } else {
            messages.push(reason);
        }
    };
    for (const result of results) {
        if (result.skipped) {
            continue;
        }
        if (result.error !== undefined) {
            if (result.hook.handler.onFailure === 'block') {
                block(`hook failed: ${result.error}`);
            }
            continue;
        }
        if (result.exitCode === 2) {
            block(result.stderr.trim() || 'blocked by a hook');
            continue;
        }
        const output = result.output;
        if (!output) {
            if (CONTEXT_EVENTS.has(event) && result.stdout.trim() !== '') {
                contexts.push(result.stdout.trim());
            }
            continue;
        }
        if (output.continue === false) {
            stop = true;
            stopReason ??= typeof output.stopReason === 'string' ? output.stopReason : undefined;
        }
        if (typeof output.systemMessage === 'string' && output.systemMessage !== '') {
            messages.push(output.systemMessage);
        }
        const specific = isPlainObject(output.hookSpecificOutput) ? output.hookSpecificOutput : undefined;
        const reason = typeof output.reason === 'string' && output.reason !== '' ? output.reason : undefined;
        let permission = typeof specific?.permissionDecision === 'string' ? specific.permissionDecision : undefined;
        if (permission === undefined && output.decision === 'approve') {
            permission = 'allow';
        }
        if (output.decision === 'block' || permission === 'deny') {
            const why =
                typeof specific?.permissionDecisionReason === 'string' && specific.permissionDecisionReason !== ''
                    ? specific.permissionDecisionReason
                    : reason;
            block(why ?? 'blocked by a hook');
        } else if (permission === 'allow' || permission === 'ask') {
            raise(permission);
        }
        if (typeof specific?.additionalContext === 'string' && specific.additionalContext.trim() !== '') {
            contexts.push(specific.additionalContext.trim());
        }
        if (isPlainObject(specific?.updatedInput)) {
            updatedInput = specific.updatedInput;
        }
    }
    return {
        blocked,
        ...(reasons.length > 0 ? { reason: reasons.join('\n') } : {}),
        ...(decision === undefined ? {} : { decision }),
        ...(contexts.length > 0 ? { additionalContext: contexts.join('\n\n') } : {}),
        stop,
        ...(stopReason === undefined ? {} : { stopReason }),
        messages,
        ...(updatedInput === undefined ? {} : { updatedInput }),
        results,
    };
}

/**
 * Runs `hooks` (from {@link matchHooks}) for `event` in parallel and combines what they decided. `payload` is the
 * event input, e.g. `{session_id, transcript_path, tool_name, tool_input}`; `hook_event_name` and `cwd` are added.
 * Never rejects: failures are in the results.
 */
export async function runHooks(
    event: HookEvent,
    hooks: readonly MatchedHook[],
    payload: Readonly<Record<string, unknown>>,
    options: RunHooksOptions,
): Promise<HooksOutcome> {
    const input = JSON.stringify({ ...payload, hook_event_name: event, cwd: payload.cwd ?? options.cwd });
    const results = await Promise.all(hooks.map((hook) => runHook(hook, input, options)));
    return aggregate(event, results);
}
