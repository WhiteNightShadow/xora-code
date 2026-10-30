import { afterEach, describe, expect, it } from 'vitest';
import {
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcError,
    RpcErrorCode,
    RpcPeer,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];

type Peer = RpcPeer<HostMethods, HostNotifications>;

function connectedPeers(): { client: Peer; server: Peer } {
    const channel = new MessageChannel();
    const client: Peer = new RpcPeer(domPortTransport(channel.port1), { methods, notifications, timeoutMs: 2_000 });
    const server: Peer = new RpcPeer(domPortTransport(channel.port2), { methods, notifications });
    cleanups.push(() => {
        client.dispose();
        server.dispose();
        channel.port1.close();
        channel.port2.close();
    });
    return { client, server };
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

describe('RpcPeer', () => {
    it('round-trips a typed request', async () => {
        const { client, server } = connectedPeers();
        server.handle('system.ping', ({ sentAt }) => ({ sentAt, receivedAt: sentAt + 1 }));
        await expect(client.request('system.ping', { sentAt: 41 })).resolves.toEqual({ sentAt: 41, receivedAt: 42 });
    });

    it('reports an unknown method', async () => {
        const { client } = connectedPeers();
        const failure = await client.request('system.info', {}).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RpcError);
        expect((failure as RpcError).code).toBe(RpcErrorCode.MethodNotFound);
    });

    it('rejects params that do not match the schema before sending', () => {
        const { client } = connectedPeers();
        expect(() => client.request('system.ping', { sentAt: 'soon' } as never)).toThrow();
    });

    it('validates the result on the serving side', async () => {
        const { client, server } = connectedPeers();
        server.handle('system.ping', () => ({ sentAt: 1 }) as never);
        const failure = await client.request('system.ping', { sentAt: 1 }).catch((error: unknown) => error);
        expect((failure as RpcError).code).toBe(RpcErrorCode.InternalError);
    });

    it('times out when the other side never answers', async () => {
        const { client, server } = connectedPeers();
        server.handle('system.ping', () => new Promise(() => undefined));
        const failure = await client.request('system.ping', { sentAt: 1 }, { timeoutMs: 50 }).catch((error) => error);
        expect((failure as RpcError).code).toBe(RpcErrorCode.Timeout);
    });

    it('rejects pending requests on dispose', async () => {
        const { client, server } = connectedPeers();
        server.handle('system.ping', () => new Promise(() => undefined));
        const pending = client.request('system.ping', { sentAt: 1 });
        client.dispose();
        await expect(pending).rejects.toMatchObject({ code: RpcErrorCode.Disposed });
    });

    it('delivers notifications to listeners', async () => {
        const { client, server } = connectedPeers();
        const received = new Promise<unknown>((resolve) => client.onNotification('thread.removed', resolve));
        server.notify('thread.removed', { threadId: 't1' });
        await expect(received).resolves.toEqual({ threadId: 't1' });
    });

    it('drops notifications that fail validation', async () => {
        const channel = new MessageChannel();
        const errors: Error[] = [];
        const peer: Peer = new RpcPeer(domPortTransport(channel.port1), {
            methods,
            notifications,
            onProtocolError: (error) => errors.push(error),
        });
        const seen: unknown[] = [];
        peer.onNotification('thread.removed', (params) => seen.push(params));
        cleanups.push(() => {
            peer.dispose();
            channel.port1.close();
            channel.port2.close();
        });
        channel.port2.postMessage({ jsonrpc: '2.0', method: 'thread.removed', params: { threadId: 7 } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(seen).toHaveLength(0);
        expect(errors).toHaveLength(1);
    });

    it('carries error data from the serving side', async () => {
        const { client, server } = connectedPeers();
        server.handle('project.list', () => {
            throw new RpcError(RpcErrorCode.Rejected, 'nope', { reason: 'busy' });
        });
        const failure = await client.request('project.list', {}).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: RpcErrorCode.Rejected, data: { reason: 'busy' } });
    });

    it('ignores malformed messages and reports them', async () => {
        const channel = new MessageChannel();
        const errors: Error[] = [];
        const peer: Peer = new RpcPeer(domPortTransport(channel.port1), {
            methods,
            onProtocolError: (error) => errors.push(error),
        });
        cleanups.push(() => {
            peer.dispose();
            channel.port1.close();
            channel.port2.close();
        });
        channel.port2.postMessage({ hello: 'world' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(errors).toHaveLength(1);
    });
});
