import type { AcpPort } from '@xora/engine';
import type { LanguageSetting, ShellInfo } from '@xora/protocol';

/**
 * What the host needs from the Electron bootstrap. In the app it is backed by an RPC channel to the main
 * process; tests and headless runs use {@link MemoryShell}.
 */
export interface ShellApi {
    info(): Promise<ShellInfo>;
    getSecret(name: string): Promise<string | null>;
    setSecret(name: string, value: string): Promise<void>;
    deleteSecret(name: string): Promise<void>;
    pickDirectory(title?: string): Promise<string | null>;
    notify(title: string, body: string, threadId?: string): Promise<void>;
    preventSleep(on: boolean): Promise<void>;
    /** The language setting, for the shell's menus, tray and dialogs. */
    setLanguage(language: LanguageSetting): Promise<void>;
    open(kind: 'external' | 'path' | 'reveal', target: string): Promise<void>;
    stageUpdate(dir: string): Promise<{ ok: boolean; version?: string; error?: string }>;
    restart(): Promise<void>;
    updateTray(running: ReadonlyArray<{ threadId: string; title: string; status: string }>): Promise<void>;
    /**
     * Has the bootstrap fork the xora engine from the app bundle as an Electron utility process. Only the app's
     * shell can; without it the host runs the engine over stdio on its own Node (tests, runs outside Electron).
     */
    startEngine?(request: EngineStart): Promise<ShellEngine>;
}

export interface EngineStart {
    /** Bundle-relative POSIX path, e.g. `engine/index.cjs`. */
    readonly entry: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** What the engine writes to stdout or stderr. */
    readonly onOutput: (text: string) => void;
}

/** An engine process the bootstrap started; ACP runs over its port. */
export interface ShellEngine {
    readonly pid: number;
    readonly port: AcpPort;
    /** Resolves with the exit code once the process has ended. */
    readonly exited: Promise<number>;
    stop(): void;
}

/** In-memory shell for tests and headless runs: secrets live in a map, dialogs return a preset answer. */
export class MemoryShell implements ShellApi {
    readonly secrets = new Map<string, string>();
    readonly notifications: Array<{ title: string; body: string; threadId?: string }> = [];
    readonly opened: Array<{ kind: string; target: string }> = [];
    pickAnswer: string | null = null;
    sleepPrevented = false;
    language: LanguageSetting | undefined;
    staged: string[] = [];
    restarts = 0;
    tray: ReadonlyArray<{ threadId: string; title: string; status: string }> = [];
    readonly #info: ShellInfo;

    constructor(info: Partial<ShellInfo> & { dataDir: string }) {
        this.#info = {
            shellVersion: '1.0.0-alpha.1',
            bundleVersion: '1.0.0-alpha.1',
            bundleDir: '',
            execPath: process.execPath,
            shellModulesDir: '',
            platform: process.platform,
            arch: process.arch,
            packaged: false,
            secureStorage: false,
            languages: ['zh-CN'],
            ...info,
        };
    }

    async info(): Promise<ShellInfo> {
        return this.#info;
    }

    async getSecret(name: string): Promise<string | null> {
        return this.secrets.get(name) ?? null;
    }

    async setSecret(name: string, value: string): Promise<void> {
        this.secrets.set(name, value);
    }

    async deleteSecret(name: string): Promise<void> {
        this.secrets.delete(name);
    }

    async pickDirectory(): Promise<string | null> {
        return this.pickAnswer;
    }

    async notify(title: string, body: string, threadId?: string): Promise<void> {
        this.notifications.push({ title, body, ...(threadId ? { threadId } : {}) });
    }

    async preventSleep(on: boolean): Promise<void> {
        this.sleepPrevented = on;
    }

    async setLanguage(language: LanguageSetting): Promise<void> {
        this.language = language;
    }

    async open(kind: 'external' | 'path' | 'reveal', target: string): Promise<void> {
        this.opened.push({ kind, target });
    }

    async stageUpdate(dir: string): Promise<{ ok: boolean; version?: string }> {
        this.staged.push(dir);
        return { ok: true };
    }

    async restart(): Promise<void> {
        this.restarts++;
    }

    async updateTray(running: ReadonlyArray<{ threadId: string; title: string; status: string }>): Promise<void> {
        this.tray = running;
    }
}
