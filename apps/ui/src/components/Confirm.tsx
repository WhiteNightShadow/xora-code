import { useEffect, useState } from 'react';
import { useStrings } from '../store.ts';
import { Modal } from './primitives.tsx';

interface Pending {
    readonly message: string;
    readonly ok?: string;
    readonly resolve: (answer: boolean) => void;
}

let present: ((pending: Pending) => void) | undefined;

/**
 * Asks the user yes or no in a dialog of the app's own, not the system's (which can end up behind the window):
 * resolves true when they confirm. Enter confirms; Escape, the backdrop and Cancel refuse.
 */
export function confirmDialog(message: string, ok?: string): Promise<boolean> {
    if (!present) return Promise.resolve(window.confirm(message));
    return new Promise((resolve) => present?.({ message, ...(ok ? { ok } : {}), resolve }));
}

/** Where the confirm dialog shows; one at a time, a new question refuses the one still open. */
export function ConfirmHost() {
    const s = useStrings();
    const [pending, setPending] = useState<Pending | undefined>();
    useEffect(() => {
        present = (next) =>
            setPending((current) => {
                current?.resolve(false);
                return next;
            });
        return () => {
            present = undefined;
        };
    }, []);
    useEffect(() => {
        if (!pending) return;
        const onKey = (event: KeyboardEvent) => {
            // A button of its own answers for itself.
            if (event.key !== 'Enter' || (event.target as HTMLElement | null)?.tagName === 'BUTTON') return;
            event.preventDefault();
            pending.resolve(true);
            setPending(undefined);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [pending]);
    if (!pending) return null;
    const answer = (value: boolean) => {
        pending.resolve(value);
        setPending(undefined);
    };
    return (
        <Modal title={s.common.confirmTitle} onClose={() => answer(false)}>
            <div className="confirm">
                <p className="confirm__message">{pending.message}</p>
                <div className="confirm__actions">
                    <button type="button" className="button" onClick={() => answer(false)}>
                        {s.common.cancel}
                    </button>
                    <button type="button" className="button button--primary" onClick={() => answer(true)}>
                        {pending.ok ?? s.common.confirm}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
