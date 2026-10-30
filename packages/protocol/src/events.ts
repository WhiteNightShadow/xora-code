import { z } from 'zod';
import {
    EffortSchema,
    ErrorItemSchema,
    FileChangeSchema,
    GoalSchema,
    ItemSchema,
    ModelRefSchema,
    MoneySchema,
    PermissionModeSchema,
    ThreadMetaSchema,
    UserMessageItemSchema,
} from './domain.ts';

/**
 * Persisted thread events. Each thread has an append-only log; `seq` increases monotonically per thread, so a
 * client resynchronises by asking for everything after the last `seq` it has seen. Streaming text deltas are
 * not persisted: they arrive as `thread.delta` notifications and the completed item replaces them.
 */

export const TurnUsageSchema = z.object({
    requests: z.number(),
    inputTokens: z.number(),
    cachedTokens: z.number(),
    outputTokens: z.number(),
    cost: MoneySchema.nullable(),
});
export type TurnUsage = z.infer<typeof TurnUsageSchema>;

export const ThreadEventPayloads = {
    'thread.created': z.object({ thread: ThreadMetaSchema }),
    'thread.renamed': z.object({ title: z.string() }),
    'thread.config': z.object({
        model: ModelRefSchema.nullable().optional(),
        mode: PermissionModeSchema.optional(),
        effort: EffortSchema.optional(),
        sessionPrompt: z.string().optional(),
    }),
    'turn.started': z.object({
        turnId: z.string(),
        input: UserMessageItemSchema,
        model: ModelRefSchema.nullable(),
        mode: PermissionModeSchema,
        effort: EffortSchema,
    }),
    'item.started': z.object({ item: ItemSchema }),
    'item.completed': z.object({ item: ItemSchema }),
    'turn.completed': z.object({
        turnId: z.string(),
        stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']),
        durationMs: z.number(),
        usage: TurnUsageSchema,
        changes: z
            .object({ files: z.array(FileChangeSchema), additions: z.number(), deletions: z.number() })
            .optional(),
    }),
    'turn.failed': z.object({ turnId: z.string(), error: ErrorItemSchema, durationMs: z.number() }),
    'goal.updated': z.object({ goal: GoalSchema }),
    'turn.reverted': z.object({
        turnId: z.string(),
        paths: z.array(z.string()),
        conflicts: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
    /** The conversation went back to before `turnId`: that turn and the later ones left the agent's context (M3-3). */
    'thread.rewound': z.object({
        turnId: z.string(),
        files: z.boolean(),
        paths: z.array(z.string()),
        conflicts: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
} as const;

export type ThreadEventKind = keyof typeof ThreadEventPayloads;
export type ThreadEventPayload<K extends ThreadEventKind> = z.infer<(typeof ThreadEventPayloads)[K]>;

export const EventEnvelopeSchema = z.object({
    threadId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    ts: z.number(),
    kind: z.string().min(1),
    payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** An envelope whose payload has been checked against its kind. */
export type ThreadEvent = {
    [K in ThreadEventKind]: Omit<EventEnvelope, 'kind' | 'payload'> & { kind: K; payload: ThreadEventPayload<K> };
}[ThreadEventKind];

export function parseThreadEvent(envelope: EventEnvelope): ThreadEvent | undefined {
    const schema = ThreadEventPayloads[envelope.kind as ThreadEventKind];
    if (!schema) {
        return undefined;
    }
    const parsed = schema.safeParse(envelope.payload);
    return parsed.success ? ({ ...envelope, payload: parsed.data } as ThreadEvent) : undefined;
}
