import { z } from 'zod';

/**
 * Session configuration the host sends in `_meta.xora` of `session/new`, `session/load`, `session/resume` and
 * `_xora/session/configure`. It carries the API key, so the engine never logs or persists it as a whole:
 * only the non-secret parts end up in the session file.
 */

export const EffortSchema = z.enum(['off', 'low', 'medium', 'high', 'max']);
export const ModeSchema = z.enum(['ask', 'auto_edit', 'plan', 'full']);
export type Mode = z.infer<typeof ModeSchema>;

const ModelInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string(),
    contextWindow: z.number(),
    maxOutput: z.number(),
    input: z.array(z.enum(['text', 'image'])),
    reasoning: z.object({
        mode: z.enum(['none', 'always', 'toggle']),
        efforts: z.array(z.enum(['low', 'medium', 'high', 'max'])),
        defaultEffort: EffortSchema,
    }),
    tools: z.boolean(),
    pricing: z.string().optional(),
});

export const ConnectionConfigSchema = z.object({
    presetId: z.string().min(1),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    wire: z.enum(['openai_chat', 'anthropic_messages']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    extraModels: z.array(ModelInfoSchema).optional(),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

export const ModelTargetSchema = z.object({
    connection: ConnectionConfigSchema,
    model: z.string().min(1),
});
export type ModelTarget = z.infer<typeof ModelTargetSchema>;

export const PromptLayerInputSchema = z.object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
});
export type PromptLayerInput = z.infer<typeof PromptLayerInputSchema>;

/** A tool the host implements; the engine only forwards calls to it (`_xora/tool/call`). */
export const HostToolSchema = z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    description: z.string(),
    /** JSON Schema of the arguments object. */
    parameters: z.record(z.string(), z.unknown()),
    kind: z.enum(['read', 'edit', 'search', 'execute', 'think', 'fetch', 'other']).default('other'),
});
export type HostTool = z.infer<typeof HostToolSchema>;

export const SessionConfigSchema = z.object({
    model: ModelTargetSchema,
    /** Tried in order when the main model is rate limited, overloaded or failing (07 §7). */
    fallbacks: z.array(ModelTargetSchema).default([]),
    /** Used for summaries during compaction; falls back to the main model. */
    fastModel: ModelTargetSchema.optional(),
    effort: EffortSchema.optional(),
    mode: ModeSchema.default('ask'),
    /** Prompt layers 2–5 and the session layer (08 §1), already in order. */
    layers: z.array(PromptLayerInputSchema).default([]),
    softContextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /** Language of the notices and permission options the user sees. */
    language: z.enum(['zh-CN', 'en']).default('zh-CN'),
    maxTurnRequests: z.number().int().positive().default(200),
    userAgent: z.string().default('XoraCode'),
    /** Extra environment for tools, e.g. `XORA_PORT` of a worktree. */
    env: z.record(z.string(), z.string()).default({}),
    /** Tools implemented by the host, e.g. the supervisor's team tools (06 §16). */
    hostTools: z.array(HostToolSchema).default([]),
    /** Built-in tools to hide, e.g. write tools for a read-only role. */
    disabledTools: z.array(z.string()).default([]),
    /**
     * MCP tools the session may use, as `mcp__<server>__<tool>` names with `*` globs (a team role's allowlist);
     * absent means every tool of the session's servers.
     */
    mcpTools: z.array(z.string()).optional(),
    /**
     * Hook events the host has handlers for (09 §4): the engine asks the host before and after tool calls, and before
     * it compacts the context on its own.
     */
    hookEvents: z.array(z.enum(['PreToolUse', 'PostToolUse', 'PreCompact'])).default([]),
    /** Language servers (04 §3). */
    lsp: z
        .object({
            /** Append new errors the server reports to the results of edits, when a server for the file is available. */
            diagnostics: z.boolean().default(true),
            /** The project is trusted: servers may come from its node_modules and may load its code. */
            trusted: z.boolean().default(false),
        })
        .prefault({}),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/** Reads and validates `_meta.xora` from an ACP request. */
export function readSessionConfig(meta: unknown): SessionConfig {
    const raw = (meta as { xora?: unknown } | null | undefined)?.xora;
    return SessionConfigSchema.parse(raw);
}

/** The part of the configuration that is safe to persist. */
export function publicConfig(config: SessionConfig): Record<string, unknown> {
    return {
        presetId: config.model.connection.presetId,
        model: config.model.model,
        effort: config.effort,
        mode: config.mode,
    };
}
