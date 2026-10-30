import { z } from 'zod';

/** Bumped on every breaking change to the UI↔host protocol. UI and host ship in the same app bundle. */
export const PROTOCOL_VERSION = 1;

export const SystemInfoSchema = z.object({
    protocolVersion: z.number().int(),
    bundleVersion: z.string(),
    hostPid: z.number().int(),
    platform: z.string(),
    arch: z.string(),
    versions: z.object({
        node: z.string(),
        electron: z.string(),
    }),
    uptimeMs: z.number().nonnegative(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

/**
 * Every method the host serves. The renderer can only call what is listed here, and both sides validate
 * params and results against these schemas.
 */
export const methods = {
    'system.ping': {
        params: z.object({ sentAt: z.number() }).strict(),
        result: z.object({ sentAt: z.number(), receivedAt: z.number() }),
    },
    'system.info': {
        params: z.object({}).strict(),
        result: SystemInfoSchema,
    },
} as const;

export type MethodName = keyof typeof methods;
export type MethodParams<M extends MethodName> = z.input<(typeof methods)[M]['params']>;
export type MethodResult<M extends MethodName> = z.output<(typeof methods)[M]['result']>;
