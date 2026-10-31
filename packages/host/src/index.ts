import {
    electronPortTransport,
    type MessagePortMainLike,
    RpcPeer,
    type ShellMethods,
    type ShellNotifications,
    shellMethods,
    shellNotifications,
} from '@xora/protocol';
import { trustSystemCertificates } from '@xora/providers';
import { HostCore } from './core.ts';
import { HostLog } from './log.ts';
import { hostPaths } from './paths.ts';
import type { ShellApi } from './shell.ts';

/**
 * Entry point of the host. The bootstrap starts it with `utilityProcess.fork`, so `process.parentPort` is the
 * channel back to the bootstrap: first an `xora:shell` port for shell services, then one `xora:connect` port
 * per window.
 */

interface ParentPortMessage {
    readonly data: unknown;
    readonly ports: readonly MessagePortMainLike[];
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
const log = new HostLog(hostPaths(dataDir).logsDir);
// Model connections, `/models` checks and update downloads use Node's TLS, not Chromium's.
try {
    trustSystemCertificates();
} catch (error) {
    log.warn(`system certificates not loaded: ${error instanceof Error ? error.message : String(error)}`);
}

class RpcShell implements ShellApi {
    readonly #peer: ShellPeer;

    constructor(peer: ShellPeer) {
        this.#peer = peer;
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
}

let core: HostCore | undefined;
const waiting: MessagePortMainLike[] = [];
let shellPeer: ShellPeer | undefined;

function serveUi(port: MessagePortMainLike): void {
    if (!core) {
        waiting.push(port);
        return;
    }
    const peer = core.connectUi(electronPortTransport(port));
    port.on('close' as 'message', () => peer.dispose());
}

async function start(peer: ShellPeer): Promise<void> {
    try {
        core = await HostCore.create({
            dataDir: dataDir as string,
            shell: new RpcShell(peer),
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
    const data = message.data as { type?: unknown } | null;
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
        void start(shellPeer);
    } else if (data?.type === 'xora:connect') {
        serveUi(port);
    }
});

process.on('uncaughtException', (error) => {
    log.error(`uncaught: ${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
