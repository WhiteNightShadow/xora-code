import { electronPortTransport, type MessagePortMainLike, PROTOCOL_VERSION, RpcPeer } from '@xora/protocol';

/**
 * Entry point of the host. The bootstrap starts it with `utilityProcess.fork`, so `process.parentPort` is the
 * channel back to the bootstrap. Each window gets its own MessagePort, delivered as an `xora:connect` message.
 */

interface ParentPortMessage {
    readonly data: unknown;
    readonly ports: readonly MessagePortMainLike[];
}

interface ParentPort {
    on(event: 'message', listener: (message: ParentPortMessage) => void): void;
    postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
    console.error('xora host must be started by the Xora Code bootstrap as an Electron utility process');
    process.exit(2);
}

const startedAt = Date.now();
const bundleVersion = process.env.XORA_BUNDLE_VERSION ?? 'unknown';
const peers = new Set<RpcPeer>();

function serve(port: MessagePortMainLike): void {
    const peer = new RpcPeer(electronPortTransport(port), {
        onProtocolError: (error) => console.warn(`ignored malformed message: ${error.message}`),
    });
    peer.handle('system.ping', ({ sentAt }) => ({ sentAt, receivedAt: Date.now() }));
    peer.handle('system.info', () => ({
        protocolVersion: PROTOCOL_VERSION,
        bundleVersion,
        hostPid: process.pid,
        platform: process.platform,
        arch: process.arch,
        versions: { node: process.versions.node, electron: process.versions.electron ?? 'unknown' },
        uptimeMs: Date.now() - startedAt,
    }));
    peers.add(peer);
}

parentPort.on('message', (message) => {
    const data = message.data as { type?: unknown } | null;
    const port = message.ports[0];
    if (data?.type === 'xora:connect' && port) {
        serve(port);
    }
});

parentPort.postMessage({ type: 'xora:host-ready', bundleVersion, pid: process.pid });
