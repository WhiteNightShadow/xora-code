import { domPortTransport, RpcPeer, type SystemInfo } from '@xora/protocol';
import { Button, StatusDot } from '@xora/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPort, type ShellInfo } from './shell.ts';

type Connection =
    | { readonly state: 'connecting' }
    | { readonly state: 'connected' }
    | { readonly state: 'failed'; readonly error: string };

export function App() {
    const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
    const [shell, setShell] = useState<ShellInfo | null>(null);
    const [system, setSystem] = useState<SystemInfo | null>(null);
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const peerRef = useRef<RpcPeer | null>(null);
    const readySignalled = useRef(false);

    const ping = useCallback(async () => {
        const peer = peerRef.current;
        if (!peer) {
            return;
        }
        const sentAt = performance.now();
        await peer.request('system.ping', { sentAt: Date.now() });
        setLatencyMs(Math.round((performance.now() - sentAt) * 10) / 10);
    }, []);

    useEffect(() => {
        const api = window.xoraShell;
        if (!api) {
            setConnection({ state: 'failed', error: '没有找到xoraShell，请在xora code桌面端里打开' });
            return;
        }
        let cancelled = false;

        const connect = async () => {
            const portPromise = nextPort();
            api.requestPort();
            const port = await portPromise;
            if (cancelled) {
                port.close();
                return;
            }
            peerRef.current?.dispose();
            const peer = new RpcPeer(domPortTransport(port), { timeoutMs: 10_000 });
            peerRef.current = peer;
            try {
                setSystem(await peer.request('system.info', {}));
                await ping();
                setConnection({ state: 'connected' });
                if (!readySignalled.current) {
                    readySignalled.current = true;
                    api.signalReady();
                }
            } catch (error) {
                setConnection({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
            }
        };

        void api.shellInfo().then((info) => {
            if (!cancelled) {
                setShell(info);
            }
        });
        void connect();
        const unsubscribe = api.onHostRestarted(() => {
            setConnection({ state: 'connecting' });
            void connect();
        });
        return () => {
            cancelled = true;
            unsubscribe();
            peerRef.current?.dispose();
            peerRef.current = null;
        };
    }, [ping]);

    const status =
        connection.state === 'connected' ? (
            <StatusDot tone="ok" label="host已连接" />
        ) : connection.state === 'connecting' ? (
            <StatusDot tone="pending" label="正在连接host" />
        ) : (
            <StatusDot tone="error" label={`连接失败：${connection.error}`} />
        );

    return (
        <main className="shell">
            <header className="shell__header">
                <h1>xora code</h1>
                <p className="shell__subtitle">新架构骨架（M0）：bootstrap、应用包和host已经接通，功能从M1开始。</p>
            </header>
            <section className="shell__card" aria-label="运行状态">
                <div className="shell__row">
                    {status}
                    <Button onClick={() => void ping()} disabled={connection.state !== 'connected'}>
                        再测一次
                    </Button>
                </div>
                <dl className="shell__facts">
                    <dt>shell版本</dt>
                    <dd>{shell?.shellVersion ?? '…'}</dd>
                    <dt>应用包</dt>
                    <dd>{shell ? `${shell.bundleVersion}（${shell.candidate}）` : '…'}</dd>
                    <dt>协议版本</dt>
                    <dd>{system?.protocolVersion ?? '…'}</dd>
                    <dt>host</dt>
                    <dd>
                        {system
                            ? `pid ${system.hostPid} · node ${system.versions.node} · electron ${system.versions.electron}`
                            : '…'}
                    </dd>
                    <dt>往返延迟</dt>
                    <dd>{latencyMs === null ? '…' : `${latencyMs} ms`}</dd>
                    <dt>数据目录</dt>
                    <dd className="shell__mono">{shell?.dataDir ?? '…'}</dd>
                </dl>
            </section>
            <footer className="shell__footer">
                <Button variant="danger" onClick={() => window.xoraShell?.restartToSafeMode()}>
                    重启到修复模式
                </Button>
            </footer>
        </main>
    );
}
