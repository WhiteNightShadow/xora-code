import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { trustSystemCertificates } from '@xora/providers';
import { createXoraAgent } from './agent.ts';
import { type AcpPort, portStream } from './port.ts';

/**
 * Process entry of the xora engine. In the app the shell forks it as an Electron utility process and sends it a
 * MessagePort, over which the host talks ACP. Started as a plain child process (tests, runs outside Electron) it
 * talks ACP over stdio. Anything the engine wants to say outside the protocol goes to stderr.
 */

interface ParentPortMessage {
    readonly data: unknown;
    readonly ports: readonly AcpPort[];
}

interface ParentPort {
    on(event: 'message', listener: (message: ParentPortMessage) => void): void;
    off(event: 'message', listener: (message: ParentPortMessage) => void): void;
}

const version = process.env.XORA_ENGINE_VERSION ?? '1.0.0-alpha.1';
const dataDir = process.env.XORA_ENGINE_DATA ?? path.join(homedir(), '.xora-engine');
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function log(message: string): void {
    process.stderr.write(`[xora-engine] ${message}\n`);
}

try {
    trustSystemCertificates();
} catch (error) {
    log(`system certificates not loaded: ${error instanceof Error ? error.message : String(error)}`);
}

/** The shell sends the ACP port as an `xora:acp` message right after forking. */
function shellPort(parent: ParentPort): Promise<AcpPort> {
    return new Promise((resolve) => {
        const onMessage = (message: ParentPortMessage) => {
            const port = message.ports[0];
            if ((message.data as { type?: unknown } | null)?.type === 'xora:acp' && port) {
                parent.off('message', onMessage);
                resolve(port);
            }
        };
        parent.on('message', onMessage);
    });
}

// A signal (the shell stopping a utility process sends SIGTERM) ends the engine through `exit`, so the language
// servers it started go with it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => process.exit(0));
}

const stream = parentPort
    ? shellPort(parentPort).then(portStream)
    : Promise.resolve(
          acp.ndJsonStream(
              Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
              Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
          ),
      );
stream
    .then((ready) => {
        const connection = createXoraAgent({ dataDir, version, log }).connect(ready);
        log(`ready (pid ${process.pid}, ${parentPort ? 'utility process' : 'stdio'})`);
        return connection.closed;
    })
    .then(() => process.exit(0))
    .catch((error: unknown) => {
        log(`connection failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
