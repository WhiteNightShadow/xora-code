import { z } from 'zod';

/**
 * Bootstrap↔host channel. The host asks the bootstrap for what only the Electron main process can do:
 * keychain-backed secrets, native dialogs, notifications, power management, opening files and URLs, and
 * staging a downloaded app bundle. The bootstrap asks the host whether work is in progress.
 */

const empty = z.object({}).strict();
const ok = z.object({ ok: z.literal(true) });

/** Secret names are opaque ids chosen by the host, e.g. `connection.<id>`. */
const SecretNameSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);

export const ShellInfoSchema = z.object({
    shellVersion: z.string(),
    bundleVersion: z.string(),
    bundleDir: z.string(),
    dataDir: z.string(),
    /** Electron executable; engines run with `ELECTRON_RUN_AS_NODE=1` on it. */
    execPath: z.string(),
    /** `node_modules` of the shell, for native modules such as node-pty. */
    shellModulesDir: z.string(),
    platform: z.string(),
    arch: z.string(),
    packaged: z.boolean(),
    /** False when the OS keychain is unavailable and secrets would only be obfuscated. */
    secureStorage: z.boolean(),
});
export type ShellInfo = z.infer<typeof ShellInfoSchema>;

export const shellMethods = {
    // Served by the bootstrap.
    'shell.info': { params: empty, result: ShellInfoSchema },
    'shell.secret.get': {
        params: z.object({ name: SecretNameSchema }).strict(),
        result: z.object({ value: z.string().nullable() }),
    },
    'shell.secret.set': {
        params: z.object({ name: SecretNameSchema, value: z.string().max(16_000) }).strict(),
        result: ok,
    },
    'shell.secret.delete': { params: z.object({ name: SecretNameSchema }).strict(), result: ok },
    'shell.dialog.directory': {
        params: z.object({ title: z.string().max(200).optional() }).strict(),
        result: z.object({ path: z.string().nullable() }),
    },
    'shell.notify': {
        params: z
            .object({ title: z.string().max(200), body: z.string().max(1000), threadId: z.string().optional() })
            .strict(),
        result: ok,
    },
    'shell.power': { params: z.object({ preventSleep: z.boolean() }).strict(), result: ok },
    'shell.open': {
        params: z
            .object({ kind: z.enum(['external', 'path', 'reveal']), target: z.string().min(1).max(4096) })
            .strict(),
        result: ok,
    },
    /** Verifies a downloaded bundle, installs it into a slot and marks it pending for the next launch. */
    'shell.update.stage': {
        params: z.object({ dir: z.string().min(1) }).strict(),
        result: z.object({ ok: z.boolean(), version: z.string().optional(), error: z.string().optional() }),
    },
    /** Running threads for the tray menu; the tray only exists while something runs or the window is hidden. */
    'shell.tray.update': {
        params: z
            .object({
                running: z
                    .array(z.object({ threadId: z.string(), title: z.string().max(200), status: z.string() }))
                    .max(50),
            })
            .strict(),
        result: ok,
    },
    /** Relaunches the app so a staged bundle takes effect. */
    'shell.update.restart': { params: empty, result: ok },

    // Served by the host.
    'host.activity': {
        params: empty,
        result: z.object({ runningTurns: z.number().int().nonnegative(), pendingApprovals: z.number().int() }),
    },
    'host.focusThread': { params: z.object({ threadId: z.string() }).strict(), result: ok },
} as const;

export type ShellMethods = typeof shellMethods;

/** Events the bootstrap pushes to the host. */
export const shellNotifications = {
    /** The user clicked a notification or tray entry for this thread. */
    'shell.openThread': z.object({ threadId: z.string() }),
    /** Window focus, used to decide whether to raise system notifications. */
    'shell.focus': z.object({ focused: z.boolean() }),
} as const;

export type ShellNotifications = typeof shellNotifications;
