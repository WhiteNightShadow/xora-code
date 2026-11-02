import { useState } from 'react';
import { host } from '../host.ts';
import { attempt, useApp, useStrings } from '../store.ts';
import { Modal, Spinner } from './primitives.tsx';

/**
 * Archive and delete for a team or workflow run that is over. Archived runs are listed apart; a deleted run goes
 * with its threads (`team.removed` / `workflow.removed` take it out of the lists).
 */
export function RunActions({
    kind,
    runId,
    archived,
    small = true,
}: {
    kind: 'team' | 'workflow';
    runId: string;
    archived: boolean;
    small?: boolean;
}) {
    const s = useStrings();
    const words = kind === 'team' ? s.team : s.workflow;
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const size = small ? ' button--small' : '';
    const archive = async () => {
        if (kind === 'team') {
            const run = await attempt(() => host.call('team.archive', { runId, archived: !archived }));
            if (run) useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [run.id]: run } }));
        } else {
            const run = await attempt(() => host.call('workflow.archiveRun', { runId, archived: !archived }));
            if (run) useApp.setState((state) => ({ workflowRuns: { ...state.workflowRuns, [run.id]: run } }));
        }
    };
    const remove = async () => {
        setBusy(true);
        await attempt(() =>
            kind === 'team' ? host.call('team.delete', { runId }) : host.call('workflow.deleteRun', { runId }),
        );
        setBusy(false);
        setConfirming(false);
    };
    return (
        <>
            <button type="button" className={`button${size}`} onClick={() => void archive()}>
                {archived ? words.unarchive : words.archive}
            </button>
            <button type="button" className={`button${size} button--danger`} onClick={() => setConfirming(true)}>
                {words.deleteRun}
            </button>
            {confirming && (
                <Modal title={words.deleteRun} onClose={() => setConfirming(false)}>
                    <div className="dialog">
                        <p>{words.confirmDeleteRun}</p>
                        <div className="row">
                            <button type="button" className="button" onClick={() => setConfirming(false)}>
                                {s.common.cancel}
                            </button>
                            <button
                                type="button"
                                className="button button--danger"
                                disabled={busy}
                                onClick={() => void remove()}
                            >
                                {busy ? <Spinner /> : null} {words.deleteRun}
                            </button>
                        </div>
                    </div>
                </Modal>
            )}
        </>
    );
}
