import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;
/** Longest tool name the OpenAI-compatible providers accept; Anthropic allows more. */
export const MAX_TOOL_NAME_LENGTH = 64;

export const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

/**
 * {@link SERVER_NAME_PATTERN}, and additionally no `__` and no trailing `_`, so that `mcp__<server>__<tool>`
 * always splits at the first `__` after the prefix and a permission rule for one server cannot match another.
 */
export function isValidServerName(name: string): boolean {
    return SERVER_NAME_PATTERN.test(name) && !name.includes('__') && !name.endsWith('_');
}

/** Turns a name from another tool or an ACP client into a valid one, e.g. `My Server!` → `My-Server`. */
export function normalizeServerName(raw: string): string {
    const name = raw
        .normalize('NFKC')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/_{2,}/g, '_')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, 40)
        .replace(/[-_]+$/, '');
    return name === '' ? 'server' : name;
}

function hasControlChars(value: string): boolean {
    return /[\0\r\n]/.test(value);
}

const NameSchema = z.string().refine(isValidServerName, {
    message: 'name must be 1-40 characters of a-z, A-Z, 0-9, _ and -, without "__" or a trailing "_"',
});

/** RFC 9110 field name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const HeadersSchema = z.record(
    z.string().regex(HEADER_NAME, 'invalid header name'),
    z.string().refine((value) => !hasControlChars(value), 'header values must not contain line breaks'),
);

const EnvSchema = z.record(
    z.string().regex(/^[^=\0]+$/, 'invalid environment variable name'),
    z.string().refine((value) => !value.includes('\0'), 'environment values must not contain NUL'),
);

export function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

const UrlSchema = z.string().refine(isHttpUrl, 'url must be an absolute http or https URL');

/** Tool names or `*` globs. `deny` wins over `allow`; without `allow` every tool not denied is allowed. */
export const ToolFilterSchema = z.object({
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
});

const commonFields = {
    name: NameSchema,
    enabled: z.boolean(),
    origin: z.enum(['global', 'project', 'plugin', 'imported']),
    /** Set by the host from the trust of the project, plugin or import; untrusted servers never start. */
    trusted: z.boolean(),
    toolFilter: ToolFilterSchema.optional(),
    /** Per tool call; progress notifications from the server restart the clock. */
    timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(24 * 60 * 60 * 1000)
        .optional(),
    maxOutputBytes: z
        .number()
        .int()
        .min(1024)
        .max(64 * 1024 * 1024)
        .optional(),
};

export const StdioServerConfigSchema = z.object({
    ...commonFields,
    transport: z.literal('stdio'),
    command: z
        .string()
        .min(1)
        .refine((value) => !hasControlChars(value), 'command must not contain control characters'),
    args: z.array(z.string().refine((value) => !value.includes('\0'), 'args must not contain NUL')).default([]),
    /** Layered over the sanitized base environment the caller passes to the connection. */
    env: EnvSchema.default({}),
    cwd: z.string().min(1).optional(),
});

export const HttpServerConfigSchema = z.object({
    ...commonFields,
    transport: z.literal('http'),
    url: UrlSchema,
    headers: HeadersSchema.default({}),
});

/** Legacy HTTP+SSE transport, kept for reading old configs. */
export const SseServerConfigSchema = z.object({
    ...commonFields,
    transport: z.literal('sse'),
    url: UrlSchema,
    headers: HeadersSchema.default({}),
});

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
    StdioServerConfigSchema,
    HttpServerConfigSchema,
    SseServerConfigSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
/** What callers may pass: `args`, `env` and `headers` can be left out. */
export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type SseServerConfig = z.infer<typeof SseServerConfigSchema>;
export type McpTransportKind = McpServerConfig['transport'];
export type McpServerOrigin = McpServerConfig['origin'];
export type ToolFilter = z.infer<typeof ToolFilterSchema>;

export type ConfigCheck =
    | { readonly ok: true; readonly config: McpServerConfig }
    | { readonly ok: false; readonly reason: string };

export function parseServerConfig(raw: unknown): ConfigCheck {
    const parsed = McpServerConfigSchema.safeParse(raw);
    if (!parsed.success) {
        const name =
            typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string'
                ? `${(raw as { name: string }).name}: `
                : '';
        const issues = parsed.error.issues.map((issue) => {
            const path = issue.path.join('.');
            return path ? `${path}: ${issue.message}` : issue.message;
        });
        return { ok: false, reason: `invalid-config: ${name}${issues.join('; ')}` };
    }
    return { ok: true, config: parsed.data };
}

function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${source}$`);
}

export function matchesToolPattern(pattern: string, toolName: string): boolean {
    return pattern.includes('*') ? globToRegExp(pattern).test(toolName) : pattern === toolName;
}

export function isToolAllowed(filter: ToolFilter | undefined, toolName: string): boolean {
    if (!filter) {
        return true;
    }
    if (filter.deny?.some((pattern) => matchesToolPattern(pattern, toolName))) {
        return false;
    }
    return filter.allow === undefined || filter.allow.some((pattern) => matchesToolPattern(pattern, toolName));
}

export function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * `mcp__<server>__<tool>` with characters outside `[a-zA-Z0-9_-]` replaced by `_`. Names over
 * {@link MAX_TOOL_NAME_LENGTH} keep a prefix of the tool name plus a hash of the original.
 */
export function qualifyToolName(server: string, tool: string): string {
    const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_') || '_';
    const prefix = `mcp__${server}__`;
    if (prefix.length + safeTool.length <= MAX_TOOL_NAME_LENGTH) {
        return prefix + safeTool;
    }
    const suffix = `_${shortHash(`${server}\0${tool}`)}`;
    return prefix + safeTool.slice(0, Math.max(1, MAX_TOOL_NAME_LENGTH - prefix.length - suffix.length)) + suffix;
}

/** Server and (sanitized) tool part of a qualified name; `undefined` when it is not one. */
export function parseQualifiedToolName(qualifiedName: string): { server: string; tool: string } | undefined {
    const match = /^mcp__([a-zA-Z0-9_-]+?)__(.+)$/.exec(qualifiedName);
    if (!match?.[1] || !match[2] || !isValidServerName(match[1])) {
        return undefined;
    }
    return { server: match[1], tool: match[2] };
}
