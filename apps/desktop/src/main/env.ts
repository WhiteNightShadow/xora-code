/**
 * Timings and test hooks read from the environment. The `XORA_TEST_*` switches exist for the rollback drill
 * (`pnpm drill`); they hide windows and quit at well-defined points but never relax any verification.
 */
export interface ShellEnv {
    readonly hideWindows: boolean;
    readonly exitAfterGood: boolean;
    readonly exitOnSafeMode: boolean;
    /** How long a bundle must run after its UI is ready before it counts as good. */
    readonly goodAfterMs: number;
    readonly uiReadyTimeoutMs: number;
    readonly hostReadyTimeoutMs: number;
}

function positiveInt(name: string, fallback: number): number {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readShellEnv(): ShellEnv {
    return {
        hideWindows: process.env.XORA_TEST_HIDE_WINDOWS === '1',
        exitAfterGood: process.env.XORA_TEST_EXIT_AFTER_GOOD === '1',
        exitOnSafeMode: process.env.XORA_TEST_EXIT_ON_SAFE_MODE === '1',
        goodAfterMs: positiveInt('XORA_GOOD_AFTER_MS', 20_000),
        uiReadyTimeoutMs: positiveInt('XORA_UI_READY_TIMEOUT_MS', 30_000),
        hostReadyTimeoutMs: positiveInt('XORA_HOST_READY_TIMEOUT_MS', 15_000),
    };
}
