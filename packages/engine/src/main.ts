import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { trustSystemCertificates } from '@xora/providers';
import { createXoraAgent } from './agent.ts';

/**
 * Process entry of the xora engine. The host starts it with `ELECTRON_RUN_AS_NODE=1` on the Electron binary
 * and talks ACP over stdio; anything the engine wants to say outside the protocol goes to stderr.
 */

const version = process.env.XORA_ENGINE_VERSION ?? '1.0.0-alpha.1';
const dataDir = process.env.XORA_ENGINE_DATA ?? path.join(homedir(), '.xora-engine');

function log(message: string): void {
    process.stderr.write(`[xora-engine] ${message}\n`);
}

try {
    trustSystemCertificates();
} catch (error) {
    log(`system certificates not loaded: ${error instanceof Error ? error.message : String(error)}`);
}

const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = createXoraAgent({ dataDir, version, log }).connect(stream);
log(`ready (pid ${process.pid})`);
connection.closed
    .then(() => process.exit(0))
    .catch((error: unknown) => {
        log(`connection failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
