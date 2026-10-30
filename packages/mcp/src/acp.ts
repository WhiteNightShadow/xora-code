import { z } from 'zod';
import {
    isValidServerName,
    type McpServerConfig,
    type McpServerOrigin,
    normalizeServerName,
    parseServerConfig,
    ToolFilterSchema,
} from './config.ts';
import { McpError } from './errors.ts';

/**
 * ACP `McpServer` objects as they travel in `session/new` (and `session/load`): the host hands its servers to an
 * engine this way, and the xora engine turns them back into configs. ACP has no fields for our extras, so they ride
 * in `_meta.xora`, which other agents ignore.
 */

export interface AcpNameValue {
    readonly name: string;
    readonly value: string;
}

/** ACP's stdio variant has no `type`; every agent must support it. */
export interface AcpMcpServerStdio {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: readonly AcpNameValue[];
    readonly _meta?: Record<string, unknown>;
}

export interface AcpMcpServerHttp {
    readonly type: 'http';
    readonly name: string;
    readonly url: string;
    readonly headers: readonly AcpNameValue[];
    readonly _meta?: Record<string, unknown>;
}

export interface AcpMcpServerSse {
    readonly type: 'sse';
    readonly name: string;
    readonly url: string;
    readonly headers: readonly AcpNameValue[];
    readonly _meta?: Record<string, unknown>;
}

export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

/** `mcpCapabilities` from the agent's `initialize` response. */
export interface AcpMcpCapabilities {
    readonly http?: boolean;
    readonly sse?: boolean;
}

const NameValueSchema = z.looseObject({ name: z.string(), value: z.string() });
const MetaSchema = z.record(z.string(), z.unknown());

const AcpRemoteSchema = z.looseObject({
    type: z.enum(['http', 'sse']),
    name: z.string().min(1),
    url: z.string(),
    headers: z.array(NameValueSchema).default([]),
    _meta: MetaSchema.optional(),
});

const AcpStdioSchema = z.looseObject({
    type: z.literal('stdio').optional(),
    name: z.string().min(1),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.array(NameValueSchema).default([]),
    _meta: MetaSchema.optional(),
});

/** An ACP `McpServer`; missing `args`, `env` or `headers` (required by ACP) are read as empty. */
export const AcpMcpServerSchema = z.union([AcpRemoteSchema, AcpStdioSchema]);

const XoraMetaSchema = z.object({
    origin: z.enum(['global', 'project', 'plugin', 'imported']).optional(),
    cwd: z.string().optional(),
    toolFilter: ToolFilterSchema.optional(),
    timeoutMs: z.number().optional(),
    maxOutputBytes: z.number().optional(),
});

type XoraMeta = z.infer<typeof XoraMetaSchema>;

function pairs(record: Readonly<Record<string, string>>): AcpNameValue[] {
    return Object.entries(record).map(([name, value]) => ({ name, value }));
}

function record(list: readonly AcpNameValue[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { name, value } of list) {
        out[name] = value;
    }
    return out;
}

/**
 * The ACP form of a config. Enabled and trusted are not carried: send only servers the host approved, e.g. with
 * {@link toAcpMcpServers}.
 */
export function toAcpMcpServer(config: McpServerConfig): AcpMcpServer {
    const xora: XoraMeta = {
        origin: config.origin,
        ...(config.transport === 'stdio' && config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(config.toolFilter === undefined ? {} : { toolFilter: config.toolFilter }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
    };
    const _meta = { xora };
    if (config.transport === 'stdio') {
        return { name: config.name, command: config.command, args: [...config.args], env: pairs(config.env), _meta };
    }
    return { type: config.transport, name: config.name, url: config.url, headers: pairs(config.headers), _meta };
}

export interface AcpConversion {
    readonly servers: AcpMcpServer[];
    readonly skipped: readonly { readonly name: string; readonly reason: 'disabled' | 'untrusted' | 'unsupported' }[];
}

/** The servers an agent may get: enabled, trusted, and over a transport its `mcpCapabilities` include. */
export function toAcpMcpServers(
    configs: readonly McpServerConfig[],
    capabilities: AcpMcpCapabilities = {},
): AcpConversion {
    const servers: AcpMcpServer[] = [];
    const skipped: { name: string; reason: 'disabled' | 'untrusted' | 'unsupported' }[] = [];
    for (const config of configs) {
        if (!config.enabled) {
            skipped.push({ name: config.name, reason: 'disabled' });
        } else if (!config.trusted) {
            skipped.push({ name: config.name, reason: 'untrusted' });
        } else if (config.transport !== 'stdio' && capabilities[config.transport] !== true) {
            skipped.push({ name: config.name, reason: 'unsupported' });
        } else {
            servers.push(toAcpMcpServer(config));
        }
    }
    return { servers, skipped };
}

/**
 * A config from an ACP `McpServer`, enabled and trusted (the client vetted it). Names that break our rules are
 * normalized. Throws {@link McpError} `invalid-config` for anything that is not a usable server.
 */
export function fromAcpMcpServer(
    server: unknown,
    defaults: { readonly origin?: McpServerOrigin } = {},
): McpServerConfig {
    const parsed = AcpMcpServerSchema.safeParse(server);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'server'}: ${issue.message}`);
        throw new McpError('invalid-config', `invalid ACP MCP server: ${issues.join('; ')}`);
    }
    const value = parsed.data;
    const remote = AcpRemoteSchema.safeParse(value);
    const meta = XoraMetaSchema.safeParse(value._meta?.xora);
    const xora: XoraMeta = meta.success ? meta.data : {};
    const common = {
        name: isValidServerName(value.name) ? value.name : normalizeServerName(value.name),
        enabled: true,
        trusted: true,
        origin: xora.origin ?? defaults.origin ?? 'global',
        ...(xora.toolFilter === undefined ? {} : { toolFilter: xora.toolFilter }),
        ...(xora.timeoutMs === undefined ? {} : { timeoutMs: xora.timeoutMs }),
        ...(xora.maxOutputBytes === undefined ? {} : { maxOutputBytes: xora.maxOutputBytes }),
    };
    let raw: unknown;
    if (remote.success) {
        raw = { ...common, transport: remote.data.type, url: remote.data.url, headers: record(remote.data.headers) };
    } else {
        const stdio = AcpStdioSchema.parse(value);
        raw = {
            ...common,
            transport: 'stdio',
            command: stdio.command,
            args: stdio.args,
            env: record(stdio.env),
            ...(xora.cwd === undefined ? {} : { cwd: xora.cwd }),
        };
    }
    const checked = parseServerConfig(raw);
    if (!checked.ok) {
        throw new McpError('invalid-config', checked.reason);
    }
    return checked.config;
}
