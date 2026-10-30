import type { ThreadMeta } from '@xora/protocol';
import { useEffect, useRef, useState } from 'react';
import { DiffView } from '../components/DiffView.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { Empty, Spinner } from '../components/primitives.tsx';
import { errorMessage, host } from '../host.ts';
import { attempt, toast, useApp, useStrings } from '../store.ts';

type Preview = Awaited<ReturnType<typeof host.call<'fs.read'>>>;

function Browser({ thread, onOpen }: { thread: ThreadMeta; onOpen: (path: string) => void }) {
    const [dir, setDir] = useState('.');
    const [entries, setEntries] = useState<
        Array<{ name: string; path: string; dir: boolean; size: number }> | undefined
    >();
    useEffect(() => {
        void host
            .call('fs.list', { threadId: thread.id, path: dir })
            .then(setEntries)
            .catch((error) => toast(errorMessage(error), 'error'));
    }, [thread.id, dir]);
    if (!entries) return <Spinner />;
    return (
        <ul className="file-list">
            {dir !== '.' && (
                <li>
                    <button type="button" onClick={() => setDir(dir.split('/').slice(0, -1).join('/') || '.')}>
                        ..
                    </button>
                </li>
            )}
            {entries.map((entry) => (
                <li key={entry.path}>
                    <button type="button" onClick={() => (entry.dir ? setDir(entry.path) : onOpen(entry.path))}>
                        {entry.dir ? `${entry.name}/` : entry.name}
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** File preview (04 §5) with inline edit (M4): select text, describe the change, review the diff, apply. */
export function FilePanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const path = useApp((state) => state.filePath);
    const [file, setFile] = useState<Preview | undefined>();
    const [rendered, setRendered] = useState(true);
    const [instruction, setInstruction] = useState('');
    const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
    const [proposal, setProposal] = useState<{ oldText: string; newText: string } | undefined>();
    const [busy, setBusy] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);

    const load = (target: string) => {
        setFile(undefined);
        setProposal(undefined);
        setSelection(undefined);
        host.call('fs.read', { threadId: thread.id, path: target })
            .then(setFile)
            .catch((error) => toast(errorMessage(error), 'error'));
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the requested file changes
    useEffect(() => {
        if (path) load(path);
    }, [path, thread.id]);

    if (!path) return <Browser thread={thread} onOpen={(target) => useApp.setState({ filePath: target })} />;
    if (!file)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );

    const generate = async () => {
        if (!selection || file.kind !== 'text') return;
        setBusy(true);
        const result = await attempt(() =>
            host.call(
                'edit.inline',
                { threadId: thread.id, path: file.path, start: selection.start, end: selection.end, instruction },
                { timeoutMs: 180_000 },
            ),
        );
        setBusy(false);
        if (result) setProposal({ oldText: result.oldText, newText: result.newText });
    };
    const apply = async () => {
        if (!proposal) return;
        const done = await attempt(() =>
            host.call('edit.apply', {
                threadId: thread.id,
                path: file.path,
                expectedOld: proposal.oldText,
                newText: proposal.newText,
            }),
        );
        if (done) {
            toast(s.file.applied, 'success');
            load(file.path);
        }
    };
    const isMarkdown = /\.(md|markdown)$/i.test(file.path);
    return (
        <div className="file-panel">
            <div className="file-panel__bar">
                <button type="button" className="link" onClick={() => useApp.setState({ filePath: undefined })}>
                    {s.file.browse}
                </button>
                <code className="file-panel__path">{file.path}</code>
                {isMarkdown && file.kind === 'text' && (
                    <button type="button" className="link" onClick={() => setRendered(!rendered)}>
                        {rendered ? s.file.source : s.file.rendered}
                    </button>
                )}
            </div>
            {file.kind === 'image' && file.data && (
                <img className="file-panel__image" alt={file.path} src={`data:${file.mimeType};base64,${file.data}`} />
            )}
            {file.kind === 'binary' && <Empty>{s.review.binary}</Empty>}
            {file.kind === 'too_large' && <Empty>{s.file.tooLarge}</Empty>}
            {file.kind === 'text' &&
                file.text !== undefined &&
                (isMarkdown && rendered ? (
                    <div className="file-panel__markdown">
                        <Markdown text={file.text} />
                    </div>
                ) : proposal ? (
                    <>
                        <DiffView oldText={proposal.oldText} newText={proposal.newText} />
                        <div className="row">
                            <button
                                type="button"
                                className="button button--primary button--small"
                                onClick={() => void apply()}
                            >
                                {s.file.accept}
                            </button>
                            <button
                                type="button"
                                className="button button--small"
                                onClick={() => setProposal(undefined)}
                            >
                                {s.file.reject}
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <textarea
                            ref={area}
                            className="file-panel__source"
                            readOnly
                            spellCheck={false}
                            value={file.text}
                            onSelect={(event) => {
                                const target = event.currentTarget;
                                setSelection(
                                    target.selectionEnd > target.selectionStart
                                        ? { start: target.selectionStart, end: target.selectionEnd }
                                        : undefined,
                                );
                            }}
                        />
                        <div className="file-panel__edit">
                            <input
                                className="input"
                                placeholder={selection ? s.file.instruction : s.file.selectFirst}
                                disabled={!selection}
                                value={instruction}
                                onChange={(event) => setInstruction(event.target.value)}
                                onKeyDown={(event) => event.key === 'Enter' && instruction.trim() && void generate()}
                            />
                            <button
                                type="button"
                                className="button button--small"
                                disabled={!selection || !instruction.trim() || busy}
                                onClick={() => void generate()}
                            >
                                {busy ? <Spinner /> : null} {s.file.rewrite}
                            </button>
                        </div>
                    </>
                ))}
        </div>
    );
}
