import type { ThreadMeta } from '@xora/protocol';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../components/primitives.tsx';
import type { PreviewBounds } from '../shell.ts';
import { attachToComposer, toast, useApp, useStrings } from '../store.ts';

function boundsOf(element: HTMLElement): PreviewBounds {
    const rect = element.getBoundingClientRect();
    return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
}

function dataUrlToBase64(dataUrl: string): string {
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/**
 * Preview browser (04 §5): a native view laid over this panel. Screenshots and element annotations go to the
 * thread's composer as attachments for the next turn (codex annotation mode / cursor design mode).
 */
export function PreviewPanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const api = window.xoraShell?.preview;
    const area = useRef<HTMLDivElement>(null);
    const [url, setUrl] = useState('http://localhost:3000');
    const [current, setCurrent] = useState<{ url: string; title: string; canGoBack: boolean } | undefined>();
    const [opened, setOpened] = useState(false);
    const [picking, setPicking] = useState(false);
    const modalOpen = useApp((state) => Boolean(state.settingsOpen || state.usageOpen || state.newThreadFor));

    useEffect(() => {
        if (!api) return;
        const off = api.onEvent((event) => {
            if (event.type === 'navigated') {
                setCurrent(event);
                setUrl(event.url);
            } else {
                setOpened(false);
            }
        });
        return () => {
            off();
            void api.close();
        };
    }, [api]);

    useEffect(() => {
        const element = area.current;
        if (!api || !element || !opened) return;
        const observer = new ResizeObserver(() => void api.setBounds(boundsOf(element)));
        observer.observe(element);
        window.addEventListener('resize', () => void api.setBounds(boundsOf(element)));
        return () => observer.disconnect();
    }, [api, opened]);

    useEffect(() => {
        if (api && opened) void api.setVisible(!modalOpen);
    }, [api, opened, modalOpen]);

    if (!api) {
        return <div className="empty">{s.preview.unavailable}</div>;
    }
    const open = async () => {
        const element = area.current;
        if (!element || !/^https?:\/\//.test(url.trim())) {
            toast(s.preview.badUrl, 'error');
            return;
        }
        await api.open(url.trim(), boundsOf(element));
        setOpened(true);
    };
    const capture = async () => {
        const image = await api.capture();
        if (image) {
            attachToComposer(thread.id, [
                { kind: 'image', name: 'preview.png', mimeType: 'image/png', data: dataUrlToBase64(image) },
            ]);
            toast(s.preview.attached, 'success');
        }
    };
    const annotate = async () => {
        setPicking(true);
        const picked = await api.annotate().finally(() => setPicking(false));
        if (!picked) return;
        const note = window.prompt(s.preview.notePrompt, '') ?? '';
        const text = [
            `页面：${picked.title} (${picked.url})`,
            `元素：\`${picked.selector}\`（${picked.tag}，位置${picked.rect.x},${picked.rect.y}，大小${picked.rect.width}×${picked.rect.height}）`,
            picked.text ? `文字：${picked.text}` : '',
            note ? `说明：${note}` : '',
            '```html',
            picked.html,
            '```',
        ]
            .filter(Boolean)
            .join('\n');
        attachToComposer(thread.id, [
            { kind: 'text', name: '页面标注.md', mimeType: 'text/markdown', data: text },
            ...(picked.image
                ? [
                      {
                          kind: 'image' as const,
                          name: 'element.png',
                          mimeType: 'image/png',
                          data: dataUrlToBase64(picked.image),
                      },
                  ]
                : []),
        ]);
        toast(s.preview.attached, 'success');
    };
    return (
        <div className="preview">
            <div className="preview__bar">
                <IconButton
                    icon="chevronLeft"
                    label={s.preview.back}
                    disabled={!current?.canGoBack}
                    onClick={() => void api.back()}
                />
                <IconButton
                    icon="refresh"
                    label={s.preview.reload}
                    disabled={!opened}
                    onClick={() => void api.reload()}
                />
                <input
                    className="input"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && void open()}
                    aria-label="url"
                />
                <button type="button" className="button button--small" onClick={() => void open()}>
                    {s.preview.go}
                </button>
            </div>
            <div className="preview__tools">
                <button type="button" className="link" disabled={!opened} onClick={() => void capture()}>
                    {s.preview.capture}
                </button>
                <button type="button" className="link" disabled={!opened || picking} onClick={() => void annotate()}>
                    {picking ? s.preview.picking : s.preview.annotate}
                </button>
                <button type="button" className="link" disabled={!opened} onClick={() => void api.devtools()}>
                    devtools
                </button>
                <button type="button" className="link" disabled={!opened} onClick={() => void api.openExternal()}>
                    {s.preview.external}
                </button>
            </div>
            <div className="preview__area" ref={area}>
                {!opened && <div className="empty">{s.preview.hint}</div>}
            </div>
        </div>
    );
}
