import type { AcpPort } from '@xora/engine';
import {
    electronPortTransport,
    type LanguageSetting,
    type MessagePortMainLike,
    RpcPeer,
    type ShellMethods,
    type ShellNotifications,
    shellMethods,
    shellNotifications,
} from '@xora/protocol';
import { trustSystemCertificates } from '@xora/providers';
import { HostCore } from './core.ts';
import { ShellEngines } from './engines/shell-engines.ts';
import { HostLog } from './log.ts';
import { hostPaths } from './paths.ts';
import type { EngineStart, ShellApi } from './shell.ts';

/**
 * Entry point of the host. The bootstrap starts it with `utilityProcess.fork`, so `process.parentPort` is the
 * channel back to the bootstrap: first an `xora:shell` port for shell services, then one `xora:connect` port
 * per window and one `xora:engine` port per engine process the host asked for.
 */

interface ParentPortMessage {
    readonly data: unknown;
    readonly ports: ReadonlyArray<MessagePortMainLike & AcpPort>;
}

interface ParentPort {
    on(event: 'message', listener: (message: ParentPortMessage) => void): void;
    postMessage(message: unknown): void;
}

type ShellPeer = RpcPeer<ShellMethods, ShellNotifications>;

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
    console.error('xora host must be started by the Xora Code bootstrap as an Electron utility process');
    process.exit(2);
}

const dataDir = process.env.XORA_DATA_DIR;
if (!dataDir) {
    console.error('XORA_DATA_DIR is not set');
    process.exit(2);
}
const bundleVersion = process.env.XORA_BUNDLE_VERSION ?? 'unknown';
const shellVersion = process.env.XORA_SHELL_VERSION ?? 'unknown';
// Packaged builds ignore it (RunAsNode fuse off), but it must not reach agents, their commands or terminals:
// it would start any other Electron app there as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;
const log = new HostLog(hostPaths(dataDir).logsDir);
// Model connections, `/models` checks and update downloads use Node's TLS, not Chromium's.
try {
    trustSystemCertificates();
} catch (error) {
    log.warn(`system certificates not loaded: ${error instanceof Error ? error.message : String(error)}`);
}

class RpcShell implements ShellApi {
    readonly #peer: ShellPeer;
    readonly #engines: ShellEngines;

    constructor(peer: ShellPeer, engines: ShellEngines) {
        this.#peer = peer;
        this.#engines = engines;
    }

    info() {
        return this.#peer.request('shell.info', {});
    }

    async getSecret(name: string) {
        return (await this.#peer.request('shell.secret.get', { name })).value;
    }

    async setSecret(name: string, value: string) {
        await this.#peer.request('shell.secret.set', { name, value });
    }

    async deleteSecret(name: string) {
        await this.#peer.request('shell.secret.delete', { name });
    }

    async pickDirectory(title?: string) {
        return (await this.#peer.request('shell.dialog.directory', title ? { title } : {}, { timeoutMs: 0 })).path;
    }

    async notify(title: string, body: string, threadId?: string) {
        await this.#peer.request('shell.notify', { title, body, ...(threadId ? { threadId } : {}) });
    }

    async preventSleep(on: boolean) {
        await this.#peer.request('shell.power', { preventSleep: on });
    }

    async setLanguage(language: LanguageSetting) {
        await this.#peer.request('shell.language', { language });
    }

    async open(kind: 'external' | 'path' | 'reveal', target: string) {
        await this.#peer.request('shell.open', { kind, target });
    }

    stageUpdate(dir: string) {
        return this.#peer.request('shell.update.stage', { dir }, { timeoutMs: 300_000 });
    }

    async restart() {
        await this.#peer.request('shell.update.restart', {});
    }

    async updateTray(running: ReadonlyArray<{ threadId: string; title: string; status: string }>) {
        await this.#peer.request('shell.tray.update', {
            running: running.map((entry) => ({ ...entry, title: entry.title.slice(0, 200) })),
        });
    }

    startEngine(request: EngineStart) {
        return this.#engines.start(request);
    }
}

let core: HostCore | undefined;
const waiting: MessagePortMainLike[] = [];
let shellPeer: ShellPeer | undefined;
let shellEngines: ShellEngines | undefined;

function serveUi(port: MessagePortMainLike): void {
    if (!core) {
        waiting.push(port);
        return;
    }
    const peer = core.connectUi(electronPortTransport(port));
    port.on('close' as 'message', () => peer.dispose());
}

async function start(peer: ShellPeer, engines: ShellEngines): Promise<void> {
    try {
        core = await HostCore.create({
            dataDir: dataDir as string,
            shell: new RpcShell(peer, engines),
            bundleVersion,
            shellVersion,
            log,
        });
    } catch (error) {
        log.error(`host failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        process.exit(1);
    }
    const ready = core;
    peer.handle('host.activity', () => ready.activity());
    peer.handle('host.focusThread', ({ threadId }) => {
        ready.bus.broadcast('ui.focusThread', { threadId });
        return { ok: true as const };
    });
    peer.onNotification('shell.focus', ({ focused }) => ready.bus.setFocused(focused));
    peer.onNotification('shell.openThread', ({ threadId }) => ready.bus.broadcast('ui.focusThread', { threadId }));
    for (const port of waiting.splice(0)) {
        serveUi(port);
    }
    ready.startBackgroundWork();
    parentPort?.postMessage({ type: 'xora:host-ready', bundleVersion, pid: process.pid });
}

parentPort.on('message', (message) => {
    const data = message.data as { type?: unknown; id?: unknown } | null;
    const port = message.ports[0];
    if (!port) {
        return;
    }
    if (data?.type === 'xora:shell' && !shellPeer) {
        shellPeer = new RpcPeer(electronPortTransport(port), {
            methods: shellMethods,
            notifications: shellNotifications,
            onProtocolError: (error) => log.warn(`shell protocol error: ${error.message}`),
        });
        shellEngines = new ShellEngines(shellPeer);
        void start(shellPeer, shellEngines);
    } else if (data?.type === 'xora:connect') {
        serveUi(port);
    } else if (data?.type === 'xora:engine' && typeof data.id === 'string') {
        shellEngines?.deliver(data.id, port);
    }
});

// The bootstrap stops the host with SIGTERM when the app quits. SessionEnd hooks get a moment (09 §4), best effort:
// nothing else is shut down here, so a host started next never races with this one over the threads.
process.once('SIGTERM', () => {
    const exit = () => process.exit(0);
    setTimeout(exit, 3_000).unref();
    void (core?.turns.endSessions('app_exit') ?? Promise.resolve()).catch(() => undefined).finally(exit);
});

process.on('uncaughtException', (error) => {
    log.error(`uncaught: ${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
