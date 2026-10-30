import type { ThreadMeta } from '@xora/protocol';
import { useState } from 'react';
import { host } from '../host.ts';
import { attempt, useStrings } from '../store.ts';
import { Field, Modal } from './primitives.tsx';

/** Goal mode (04 §6): objective, acceptance command, round and budget limits. */
export function GoalDialog({ thread, onClose }: { thread: ThreadMeta; onClose: () => void }) {
    const s = useStrings();
    const [objective, setObjective] = useState('');
    const [command, setCommand] = useState('');
    const [rounds, setRounds] = useState(8);
    const [budget, setBudget] = useState('');
    const [busy, setBusy] = useState(false);
    const start = async () => {
        setBusy(true);
        const result = await attempt(() =>
            host.call('goal.start', {
                threadId: thread.id,
                objective,
                ...(command.trim() ? { acceptCommand: command.trim() } : {}),
                maxRounds: rounds,
                ...(budget.trim() && Number(budget) > 0 ? { budget: Number(budget) } : {}),
            }),
        );
        setBusy(false);
        if (result) onClose();
    };
    return (
        <Modal title={s.goal.title} onClose={onClose}>
            <div className="dialog">
                <Field label={s.goal.objective}>
                    <textarea
                        className="textarea"
                        rows={4}
                        value={objective}
                        onChange={(event) => setObjective(event.target.value)}
                    />
                </Field>
                <Field label={s.goal.command} hint={s.goal.commandHint}>
                    <input
                        className="input"
                        value={command}
                        placeholder="pnpm test"
                        onChange={(event) => setCommand(event.target.value)}
                    />
                </Field>
                <Field label={s.goal.rounds}>
                    <input
                        className="input"
                        type="number"
                        min={1}
                        max={50}
                        value={rounds}
                        onChange={(event) => setRounds(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
                    />
                </Field>
                <Field label={s.goal.budget}>
                    <input
                        className="input"
                        type="number"
                        min={0}
                        step={0.5}
                        value={budget}
                        placeholder={s.settings.noLimit}
                        onChange={(event) => setBudget(event.target.value)}
                    />
                </Field>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !objective.trim()}
                        onClick={() => void start()}
                    >
                        {s.goal.start}
                    </button>
                    <button type="button" className="button" onClick={onClose}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

export function GoalBanner({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const goal = thread.goal;
    if (!goal) return null;
    return (
        <div className={`goal-banner goal-banner--${goal.state}`}>
            <strong>{s.goal.label}</strong>
            <span className="goal-banner__text">{goal.objective}</span>
            <span>
                {s.goal.states[goal.state]} · {goal.rounds}/{goal.maxRounds}
            </span>
            {goal.lastCheck && !goal.lastCheck.passed && goal.state === 'active' && (
                <span className="muted">{s.goal.lastFailed}</span>
            )}
            {goal.state === 'active' && (
                <button
                    type="button"
                    className="link"
                    onClick={() => void attempt(() => host.call('goal.stop', { threadId: thread.id }))}
                >
                    {s.goal.stop}
                </button>
            )}
        </div>
    );
}
