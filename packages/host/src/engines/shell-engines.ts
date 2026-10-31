import type { AcpPort } from '@xora/engine';
import type { RpcPeer, ShellMethods, ShellNotifications } from '@xora/protocol';
import type { EngineStart, ShellEngine } from '../shell.ts';

type ShellPeer = RpcPeer<ShellMethods, ShellNotifications>;

/** How long output that arrives after an engine exited, such as its crash report, is still passed on. */
const LATE_OUTPUT_MS = 5_000;

/**
 * The host's side of `shell.engine.*`. The bootstrap forks the engine, answers over the shell channel and sends
 * the engine's ACP port on the parent port; the reply and the port are paired here by engine id.
 */
export class ShellEngines {
    readonly #peer: ShellPeer;
    readonly #ports = new Map<string, (port: AcpPort) => void>();
    readonly #engines = new Map<string, { onOutput: (text: string) => void; exit: (code: number) => void }>();
    #next = 0;

    constructor(peer: ShellPeer) {
        this.#peer = peer;
        peer.onNotification('shell.engine.output', ({ id, text }) => this.#engines.get(id)?.onOutput(text));
        peer.onNotification('shell.engine.exit', ({ id, code }) => {
            this.#engines.get(id)?.exit(code);
            setTimeout(() => this.#engines.delete(id), LATE_OUTPUT_MS);
        });
    }

    /** The port of an `xora:engine` message on the parent port. */
    deliver(id: string, port: AcpPort): void {
        const take = this.#ports.get(id);
        this.#ports.delete(id);
        if (take) {
            take(port);
        } else {
            port.close();
        }
    }

    async start(request: EngineStart): Promise<ShellEngine> {
        const id = `engine-${++this.#next}`;
        const port = new Promise<AcpPort>((resolve) => this.#ports.set(id, resolve));
        const exited = new Promise<number>((resolve) => {
            this.#engines.set(id, { onOutput: request.onOutput, exit: resolve });
        });
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.env)) {
            if (value !== undefined) env[name] = value;
        }
        const stop = () => {
            this.#peer.request('shell.engine.stop', { id }).catch(() => undefined);
        };
        try {
            const { pid } = await this.#peer.request(
                'shell.engine.start',
                { id, entry: request.entry, env },
                { timeoutMs: 30_000 },
            );
            return { pid, port: await port, exited, stop };
        } catch (error) {
            this.#ports.delete(id);
            this.#engines.delete(id);
            // A start that timed out may have happened after all.
            stop();
            throw error;
        }
    }
}
