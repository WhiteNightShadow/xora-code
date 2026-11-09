import type { DiffFile, ThreadMeta } from '@xora/protocol';
import { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '../components/Confirm.tsx';
import { AutoFocusTextarea, Empty, Spinner } from '../components/primitives.tsx';
import { errorMessage, host } from '../host.ts';
import { attempt, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';

interface LineComment {
    readonly file: string;
    readonly line: number;
    readonly code: string;
    readonly text: string;
}

/**
 * Working-tree review (03 §4, 04 §4): unstaged and staged views, hunk-level stage, unstage and revert, line
 * comments collected into one message for the agent, and commit.
 */
export function WorkingTreePanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const [staged, setStaged] = useState(false);
    const [data, setData] = useState<{ files: DiffFile[]; isRepo: boolean; branch?: string } | undefined>();
    const [selected, setSelected] = useState<Record<string, string[]>>({});
    const [comments, setComments] = useState<LineComment[]>([]);
    const [draft, setDraft] = useState<{ file: string; line: number; code: string } | undefined>();
    const [draftText, setDraftText] = useState('');
    const [message, setMessage] = useState('');
    const version = useApp((state) => state.threads[thread.id]?.lastSeq);

    const load = useCallback(() => {
        host.call('git.diff', { threadId: thread.id, staged })
            .then((result) => {
                setData(result);
                setSelected({});
            })
            .catch((error) => toast(errorMessage(error), 'error'));
    }, [thread.id, staged]);
    // Reload when the thread advances (the agent may have changed files).
    // biome-ignore lint/correctness/useExhaustiveDependencies: version is the trigger
    useEffect(load, [load, version]);

    if (!data)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );
    if (!data.isRepo) return <Empty>{s.workingTree.notRepo}</Empty>;

    const act = async (file: string, action: 'stage' | 'unstage' | 'revert', hunkIds: string[]) => {
        if (action === 'revert' && !(await confirmDialog(s.workingTree.confirmRevert))) return;
        const done = await attempt(() =>
            host.call('git.hunks', { threadId: thread.id, path: file, hunkIds, action, staged }),
        );
        if (done) load();
    };
    const sendComments = async () => {
        const text = [
            s.workingTree.commentsIntro,
            ...comments.map(
                (comment) => `- ${comment.file}:${comment.line}\n  \`${comment.code.trim()}\`\n  ${comment.text}`,
            ),
        ].join('\n');
        const started = await attempt(() => host.call('turn.start', { threadId: thread.id, text }));
        if (started) setComments([]);
    };
    const commit = async () => {
        const result = await attempt(() => host.call('git.commit', { threadId: thread.id, message, all: !staged }));
        if (result) {
            toast(format(s.workingTree.committed, { commit: result.commit.slice(0, 8) }), 'success');
            setMessage('');
            load();
        }
    };

    return (
        <div className="working-tree">
            <div className="working-tree__bar">
                <div className="segmented">
                    <button type="button" className={!staged ? 'is-active' : ''} onClick={() => setStaged(false)}>
                        {s.workingTree.unstaged}
                    </button>
                    <button type="button" className={staged ? 'is-active' : ''} onClick={() => setStaged(true)}>
                        {s.workingTree.staged}
                    </button>
                </div>
                {data.branch && <code>{data.branch}</code>}
                <button type="button" className="link" onClick={load}>
                    {s.workingTree.refresh}
                </button>
            </div>
            {data.files.length === 0 && <Empty>{s.workingTree.clean}</Empty>}
            {data.files.map((file) => {
                const chosen = selected[file.newPath] ?? [];
                return (
                    <div key={`${file.oldPath}:${file.newPath}`} className="wt-file">
                        <div className="wt-file__header">
                            <code>{file.newPath}</code>
                            <span className="wt-file__actions">
                                {chosen.length > 0 && (
                                    <>
                                        <button
                                            type="button"
                                            className="link"
                                            onClick={() => void act(file.newPath, staged ? 'unstage' : 'stage', chosen)}
                                        >
                                            {staged ? s.workingTree.unstage : s.workingTree.stage}
                                        </button>
                                        {!staged && (
                                            <button
                                                type="button"
                                                className="link link--danger"
                                                onClick={() => void act(file.newPath, 'revert', chosen)}
                                            >
                                                {s.workingTree.revert}
                                            </button>
                                        )}
                                    </>
                                )}
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() =>
                                        void act(
                                            file.newPath,
                                            staged ? 'unstage' : 'stage',
                                            file.hunks.map((hunk) => hunk.id),
                                        )
                                    }
                                >
                                    {staged ? s.workingTree.unstageFile : s.workingTree.stageFile}
                                </button>
                            </span>
                        </div>
                        {file.binary && <div className="muted">{s.review.binary}</div>}
                        {file.hunks.map((hunk) => (
                            <div key={hunk.id} className="wt-hunk">
                                <label className="wt-hunk__header">
                                    <input
                                        type="checkbox"
                                        checked={chosen.includes(hunk.id)}
                                        onChange={(event) =>
                                            setSelected({
                                                ...selected,
                                                [file.newPath]: event.target.checked
                                                    ? [...chosen, hunk.id]
                                                    : chosen.filter((id) => id !== hunk.id),
                                            })
                                        }
                                    />
                                    <code>{hunk.header}</code>
                                </label>
                                <div className="diff diff--inline">
                                    {hunk.lines.map((line, index) => {
                                        const kind = line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'context';
                                        const number = line.newLine ?? line.oldLine ?? 0;
                                        return (
                                            <button
                                                type="button"
                                                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional within a hunk
                                                key={`${hunk.id}-${index}`}
                                                className={`diff__row diff__row--${kind} diff__row--button`}
                                                title={s.workingTree.addComment}
                                                onClick={() => {
                                                    setDraft({ file: file.newPath, line: number, code: line.text });
                                                    setDraftText('');
                                                }}
                                            >
                                                <span className="diff__num">{line.oldLine ?? ''}</span>
                                                <span className="diff__num">{line.newLine ?? ''}</span>
                                                <span className="diff__marker">
                                                    {line.kind === ' ' ? '' : line.kind === '-' ? '−' : '+'}
                                                </span>
                                                <span className="diff__text">{line.text || ' '}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                {draft &&
                                    draft.file === file.newPath &&
                                    hunk.lines.some((line) => (line.newLine ?? line.oldLine) === draft.line) && (
                                        <div className="wt-comment">
                                            <AutoFocusTextarea
                                                className="textarea"
                                                rows={2}
                                                placeholder={format(s.workingTree.commentOn, {
                                                    file: draft.file,
                                                    line: draft.line,
                                                })}
                                                value={draftText}
                                                onChange={(event) => setDraftText(event.target.value)}
                                            />
                                            <div className="row">
                                                <button
                                                    type="button"
                                                    className="button button--small button--primary"
                                                    disabled={!draftText.trim()}
                                                    onClick={() => {
                                                        setComments([
                                                            ...comments,
                                                            { ...draft, text: draftText.trim() },
                                                        ]);
                                                        setDraft(undefined);
                                                    }}
                                                >
                                                    {s.workingTree.addComment}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="button button--small"
                                                    onClick={() => setDraft(undefined)}
                                                >
                                                    {s.common.cancel}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                            </div>
                        ))}
                    </div>
                );
            })}
            {comments.length > 0 && (
                <div className="wt-comments">
                    <strong>{format(s.workingTree.pending, { count: comments.length })}</strong>
                    <ul>
                        {comments.map((comment, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: several comments can target one line
                            <li key={`${comment.file}-${comment.line}-${index}`}>
                                <code>
                                    {comment.file}:{comment.line}
                                </code>{' '}
                                {comment.text}
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() => setComments(comments.filter((_, other) => other !== index))}
                                >
                                    ×
                                </button>
                            </li>
                        ))}
                    </ul>
                    <button
                        type="button"
                        className="button button--primary button--small"
                        disabled={thread.status === 'running'}
                        onClick={() => void sendComments()}
                    >
                        {s.workingTree.sendComments}
                    </button>
                </div>
            )}
            {data.files.length > 0 && (
                <div className="wt-commit">
                    <textarea
                        className="textarea"
                        rows={2}
                        placeholder={s.workingTree.commitMessage}
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                    />
                    <button
                        type="button"
                        className="button button--small"
                        disabled={!message.trim()}
                        onClick={() => void commit()}
                    >
                        {staged ? s.workingTree.commitStaged : s.workingTree.commitAll}
                    </button>
                </div>
            )}
        </div>
    );
}
