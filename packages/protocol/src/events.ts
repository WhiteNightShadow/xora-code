import { z } from 'zod';

/**
 * Envelope for thread events streamed from the host. `seq` increases monotonically per thread, so a client
 * resynchronises by asking for everything after the last `seq` it has seen. Event kinds arrive in M1.
 */
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
