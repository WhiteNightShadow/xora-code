import '@xterm/xterm/css/xterm.css';
import type { ThreadMeta } from '@xora/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, host } from '../host.ts';
import { useStrings } from '../store.ts';

/** A real shell in the thread's working directory (04 §5), backed by a pty in the host. */
export function TerminalPanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const element = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | undefined>();
    useEffect(() => {
        const container = element.current;
        if (!container) return;
        const styles = getComputedStyle(document.documentElement);
        const terminal = new Terminal({
            fontFamily: styles.getPropertyValue('--xk-font-mono'),
            fontSize: 12.5,
            cursorBlink: true,
            scrollback: 5000,
            theme: {
                background: styles.getPropertyValue('--xk-bg-sunken').trim() || '#0d0f12',
                foreground: styles.getPropertyValue('--xk-text').trim() || '#e6e8eb',
            },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(container);
        fit.fit();
        let terminalId: string | undefined;
        const offOutput = host.on('terminal.output', ({ terminalId: id, data }) => {
            if (id === terminalId) terminal.write(data);
        });
        const offExit = host.on('terminal.exit', ({ terminalId: id, exitCode }) => {
            if (id === terminalId) terminal.write(`\r\n[进程已退出，退出码${exitCode ?? '?'}]\r\n`);
        });
        const input = terminal.onData((data) => {
            if (terminalId) void host.call('terminal.write', { terminalId, data }).catch(() => undefined);
        });
        host.call('terminal.open', { threadId: thread.id, cols: terminal.cols, rows: terminal.rows })
            .then((result) => {
                terminalId = result.terminalId;
                if (result.scrollback) terminal.write(result.scrollback);
                terminal.focus();
            })
            .catch((failure) => setError(errorMessage(failure)));
        const observer = new ResizeObserver(() => {
            fit.fit();
            if (terminalId)
                void host
                    .call('terminal.resize', { terminalId, cols: terminal.cols, rows: terminal.rows })
                    .catch(() => undefined);
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            input.dispose();
            offOutput();
            offExit();
            terminal.dispose();
        };
    }, [thread.id]);
    return (
        <div className="terminal-panel">
            {error && <div className="callout callout--error">{s.common.error.replace('{message}', error)}</div>}
            <div className="terminal-panel__screen" ref={element} />
        </div>
    );
}
