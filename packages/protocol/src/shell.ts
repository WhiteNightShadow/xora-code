import { z } from 'zod';
import { LanguageSettingSchema } from './language.ts';

/**
 * Bootstrap↔host channel. The host asks the bootstrap for what only the Electron main process can do:
 * keychain-backed secrets, native dialogs, notifications, power management, opening files and URLs, starting
 * the xora engine as a utility process, and staging a downloaded app bundle. The bootstrap asks the host
 * whether work is in progress.
 */

const empty = z.object({}).strict();
const ok = z.object({ ok: z.literal(true) });

/** Secret names are opaque ids chosen by the host, e.g. `connection.<id>`. */
const SecretNameSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);

/** Engine process ids are chosen by the host and unique while it runs. */
const EngineIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const ShellInfoSchema = z.object({
    shellVersion: z.string(),
    bundleVersion: z.string(),
    bundleDir: z.string(),
    dataDir: z.string(),
    /** Electron executable, for diagnostics: the engine is a utility process, nothing runs this as plain Node. */
    execPath: z.string(),
    /** `node_modules` of the shell, for native modules such as node-pty. */
    shellModulesDir: z.string(),
    platform: z.string(),
    arch: z.string(),
    packaged: z.boolean(),
    /** False when the OS keychain is unavailable and secrets would only be obfuscated. */
    secureStorage: z.boolean(),
    /** The app locale, then the system's preferred languages: what the language setting `system` follows. */
    languages: z.array(z.string()).optional(),
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
    /** The language setting, which the shell's menus, tray and dialogs follow. */
    'shell.language': { params: z.object({ language: LanguageSettingSchema }).strict(), result: ok },
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
    /**
     * Forks a file of the running app bundle (the xora engine) as an Electron utility process; only the main
     * process can. Its ACP port reaches the host as an `xora:engine` message with the same `id` on the parent
     * port, apart from this reply. Output and exit follow as notifications.
     */
    'shell.engine.start': {
        params: z
            .object({
                id: EngineIdSchema,
                /** Bundle-relative POSIX path, e.g. `engine/index.cjs`. */
                entry: z.string().min(1).max(512),
                env: z.record(z.string(), z.string()),
            })
            .strict(),
        result: z.object({ pid: z.number().int() }),
    },
    'shell.engine.stop': { params: z.object({ id: EngineIdSchema }).strict(), result: ok },

    // Served by the host.
    'host.activity': {
        params: empty,
        result: z.object({
            runningTurns: z.number().int().nonnegative(),
            pendingApprovals: z.number().int(),
            /** Workflow runs that are not over (queued, running, waiting at a gate). */
            workflowRuns: z.number().int().nonnegative().optional(),
            /** Workflows whose schedule, file, git or webhook triggers are on: they need the app running. */
            workflowTriggers: z.number().int().nonnegative().optional(),
        }),
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
    /** What an engine started with `shell.engine.start` wrote to stdout or stderr. */
    'shell.engine.output': z.object({ id: z.string(), text: z.string() }),
    /** An engine started with `shell.engine.start` has exited. */
    'shell.engine.exit': z.object({ id: z.string(), code: z.number().int() }),
} as const;

export type ShellNotifications = typeof shellNotifications;
