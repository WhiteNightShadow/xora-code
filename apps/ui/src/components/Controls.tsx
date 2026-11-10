import type { Effort, ModelRef, PermissionMode, ThreadMeta } from '@xora/protocol';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { host } from '../host.ts';
import { attempt, openSettings, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { effortsOf } from '../thinking.ts';
import type { TurnView } from '../timeline.ts';
import { Icon, type IconName } from './Icon.tsx';
import { formatMoney, formatTokens } from './primitives.tsx';

export const MODES: PermissionMode[] = ['ask', 'auto_edit', 'plan', 'full'];

export const MODE_ICONS: Record<PermissionMode, IconName> = {
    ask: 'shield',
    auto_edit: 'pencil',
    plan: 'list',
    full: 'bolt',
};

/**
 * A button that opens a small panel above or below it. The panel closes on Escape, a click outside, or when its
 * content calls `close` (a pick).
 */
export function Popover({
    label,
    trigger,
    children,
    placement = 'up',
    align = 'start',
    className,
    triggerClassName,
    disabled,
}: {
    label: string;
    trigger: ReactNode;
    children: (close: () => void) => ReactNode;
    placement?: 'up' | 'down';
    align?: 'start' | 'end';
    className?: string;
    triggerClassName?: string;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);
    return (
        <div className={`popover${className ? ` ${className}` : ''}`} ref={ref}>
            <button
                type="button"
                className={`popover__trigger${triggerClassName ? ` ${triggerClassName}` : ''}${open ? ' is-open' : ''}`}
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                title={label}
                disabled={disabled}
                onClick={() => setOpen(!open)}
            >
                {trigger}
            </button>
            {open && (
                <div className={`popover__panel is-${placement} is-${align}`} role="menu" aria-label={label}>
                    {children(() => setOpen(false))}
                </div>
            )}
        </div>
    );
}

export interface Choice<T extends string> {
    readonly value: T;
    readonly label: string;
    readonly hint?: string;
    readonly icon?: IconName;
    readonly tone?: 'warn';
}

/** The options of a picker: the current one checked, each with a line saying what it does. */
export function Choices<T extends string>({
    value,
    options,
    onPick,
}: {
    value: T | undefined;
    options: readonly Choice<T>[];
    onPick: (value: T) => void;
}) {
    return (
        <div className="choices">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === value}
                    className={`choice${option.value === value ? ' is-active' : ''}${option.tone ? ` is-${option.tone}` : ''}`}
                    onClick={() => onPick(option.value)}
                >
                    <span className="choice__icon">
                        <Icon name={option.icon ?? 'check'} size={14} />
                    </span>
                    <span className="choice__text">
                        <span className="choice__label">{option.label}</span>
                        {option.hint && <span className="choice__hint">{option.hint}</span>}
                    </span>
                    {option.value === value && <Icon name="check" size={14} className="choice__check" />}
                </button>
            ))}
        </div>
    );
}

function updateThread(
    thread: ThreadMeta,
    patch: { mode?: PermissionMode; effort?: Effort; model?: { connectionId: string; model: string } },
) {
    return attempt(() => host.call('thread.update', { threadId: thread.id, ...patch }));
}

/** Ask, auto edit, plan or full access: switchable at any time, a running turn included (the host re-checks). */
export function ModePicker({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    return (
        <Popover
            label={`${s.composer.modeTitle}：${s.modes[thread.mode]}`}
            className="picker"
            triggerClassName={`picker__trigger mode-chip is-${thread.mode}`}
            trigger={
                <>
                    <Icon name={MODE_ICONS[thread.mode]} size={13} />
                    {s.modes[thread.mode]}
                    <Icon name="chevronDown" size={12} className="picker__chevron" />
                </>
            }
        >
            {(close) => (
                <>
                    <div className="popover__title">{s.composer.modeTitle}</div>
                    <Choices
                        value={thread.mode}
                        options={MODES.map((mode) => ({
                            value: mode,
                            label: s.modes[mode],
                            hint: s.modeHints[mode],
                            icon: MODE_ICONS[mode],
                            ...(mode === 'full' ? { tone: 'warn' as const } : {}),
                        }))}
                        onPick={(mode) => {
                            close();
                            if (mode !== thread.mode) void updateThread(thread, { mode });
                        }}
                    />
                    <div className="popover__note">{s.composer.modeNote}</div>
                </>
            )}
        </Popover>
    );
}

function modelKey(option: { connectionId: string; model: string }): string {
    return `${option.connectionId}::${option.model}`;
}

/**
 * The model to work with: shown as it is and changed with `onChange`, so the same control serves a conversation and
 * a page that starts one.
 */
export function ModelChooser({
    value,
    onChange,
    placement,
    empty,
}: {
    value: ModelRef | undefined;
    onChange: (model: ModelRef) => void;
    /** Where its list opens: above the control unless it sits high on the page. */
    placement?: 'up' | 'down';
    /** What it says with no model chosen. */
    empty?: string;
}) {
    const s = useStrings();
    const models = useApp((state) => state.models);
    if (models.length === 0) {
        return (
            <button type="button" className="picker__trigger" onClick={() => openSettings('models')}>
                <Icon name="sparkle" size={13} /> {s.welcome.connectModel}
            </button>
        );
    }
    const current = models.find(
        (option) => value && option.connectionId === value.connectionId && option.model.id === value.model,
    );
    return (
        <Popover
            label={s.composer.modelTitle}
            className="picker"
            triggerClassName="picker__trigger"
            {...(placement ? { placement } : {})}
            trigger={
                <>
                    <Icon name="sparkle" size={13} />
                    <span className="picker__value">
                        {current?.model.name ?? value?.model ?? empty ?? s.thread.noModel}
                    </span>
                    <Icon name="chevronDown" size={12} className="picker__chevron" />
                </>
            }
        >
            {(close) => (
                <>
                    <div className="popover__title">{s.composer.modelTitle}</div>
                    <div className="popover__scroll">
                        <Choices
                            value={value ? modelKey(value) : undefined}
                            options={models.map((option) => ({
                                value: modelKey({ connectionId: option.connectionId, model: option.model.id }),
                                label: option.model.name,
                                hint: option.connectionName,
                                icon: 'sparkle' as const,
                            }))}
                            onPick={(picked) => {
                                close();
                                const [connectionId, model] = picked.split('::');
                                if (connectionId && model) onChange({ connectionId, model });
                            }}
                        />
                    </div>
                    <button
                        type="button"
                        className="popover__footer"
                        onClick={() => {
                            close();
                            openSettings('models');
                        }}
                    >
                        <Icon name="gear" size={13} /> {s.composer.manageModels}
                    </button>
                </>
            )}
        </Popover>
    );
}

export function ModelPicker({ thread }: { thread: ThreadMeta }) {
    return (
        <ModelChooser
            value={thread.model ?? undefined}
            onChange={(model) => {
                if (model.connectionId !== thread.model?.connectionId || model.model !== thread.model?.model) {
                    void updateThread(thread, { model });
                }
            }}
        />
    );
}

/** The thinking level, for a model that has one to choose (thinking.ts); nothing for one that has not. */
export function EffortChooser({
    model,
    value,
    onChange,
    placement,
}: {
    model: ModelRef | undefined;
    value: Effort | undefined;
    onChange: (effort: Effort) => void;
    placement?: 'up' | 'down';
}) {
    const s = useStrings();
    const models = useApp((state) => state.models);
    const current = models.find(
        (option) => model && option.connectionId === model.connectionId && option.model.id === model.model,
    );
    const efforts = effortsOf(current?.model.reasoning);
    if (efforts.length < 2) return null;
    const shown = value && efforts.includes(value) ? value : undefined;
    return (
        <Popover
            label={s.composer.effortTitle}
            className="picker"
            triggerClassName="picker__trigger"
            {...(placement ? { placement } : {})}
            trigger={
                <>
                    <Icon name="brain" size={13} />
                    {shown ? s.efforts[shown] : '—'}
                    <Icon name="chevronDown" size={12} className="picker__chevron" />
                </>
            }
        >
            {(close) => (
                <>
                    <div className="popover__title">{s.composer.effortTitle}</div>
                    <Choices
                        value={shown}
                        options={efforts.map((effort) => ({
                            value: effort,
                            label: s.efforts[effort],
                            icon: 'brain' as const,
                        }))}
                        onPick={(effort) => {
                            close();
                            onChange(effort);
                        }}
                    />
                </>
            )}
        </Popover>
    );
}

/** Thinking effort, for models that have it. */
export function EffortPicker({ thread }: { thread: ThreadMeta }) {
    return (
        <EffortChooser
            model={thread.model ?? undefined}
            value={thread.effort}
            onChange={(effort) => {
                if (effort !== thread.effort) void updateThread(thread, { effort });
            }}
        />
    );
}

/** A ring filled as far as the context is: it turns amber where compaction starts and red where it summarises. */
function Ring({ ratio }: { ratio: number }) {
    const radius = 7;
    const length = 2 * Math.PI * radius;
    return (
        <svg className="ring" width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
            <circle className="ring__track" cx={9} cy={9} r={radius} />
            <circle
                className="ring__fill"
                cx={9}
                cy={9}
                r={radius}
                strokeDasharray={length}
                strokeDashoffset={length * (1 - Math.min(1, Math.max(0, ratio)))}
            />
        </svg>
    );
}

/**
 * How full the context is, and what compaction has done: the ring in the composer; a click shows the numbers,
 * when the engine compacts on its own, and a button to compact now.
 */
export function ContextMeter({ thread, turns }: { thread: ThreadMeta; turns: readonly TurnView[] }) {
    const s = useStrings();
    const [busy, setBusy] = useState(false);
    const context = thread.context;
    const ratio = context && context.size > 0 ? context.used / context.size : 0;
    const percent = Math.round(ratio * 100);
    const compactions = turns.flatMap((turn) =>
        turn.items.flatMap((item) => (item.type === 'compaction' && item.status === 'completed' ? [item] : [])),
    );
    const last = compactions.at(-1);
    const running = thread.status === 'running' || thread.status === 'awaiting_approval';
    const level = ratio >= 0.8 ? 'is-high' : ratio >= 0.6 ? 'is-mid' : '';
    const compact = async () => {
        setBusy(true);
        const result = await attempt(() => host.call('turn.compact', { threadId: thread.id }, { timeoutMs: 300_000 }));
        setBusy(false);
        if (result && !result.compacted) toast(s.context.notCompacted);
    };
    return (
        <Popover
            label={s.context.title}
            align="end"
            className="context-meter"
            triggerClassName={`context-meter__trigger ${level}`}
            trigger={
                <>
                    <Ring ratio={ratio} />
                    <span>{context ? `${percent}%` : '—'}</span>
                </>
            }
        >
            {() => (
                <div className="context-card">
                    <div className="popover__title">{s.context.title}</div>
                    <div className="context-card__value">
                        {context
                            ? format(s.context.used, {
                                  used: formatTokens(context.used),
                                  size: formatTokens(context.size),
                              })
                            : s.context.empty}
                        {context && <strong className={level}>{percent}%</strong>}
                    </div>
                    <div className="context-card__bar">
                        <span className={level} style={{ width: `${Math.min(100, percent)}%` }} />
                        <i style={{ left: '60%' }} />
                        <i style={{ left: '80%' }} />
                    </div>
                    <p className="context-card__hint">{s.context.rules}</p>
                    <div className="context-card__row">
                        <Icon name="compress" size={13} />
                        {!last
                            ? s.context.notCompacted
                            : last.before && last.after
                              ? format(s.context.compacted, {
                                    count: compactions.length,
                                    before: formatTokens(last.before),
                                    after: formatTokens(last.after),
                                })
                              : format(s.context.compactedTimes, { count: compactions.length })}
                    </div>
                    {thread.tokens && (
                        <div className="context-card__row">
                            <Icon name="chart" size={13} />
                            {format(s.context.spent, {
                                input: formatTokens(thread.tokens.input),
                                output: formatTokens(thread.tokens.output),
                            })}
                            {thread.cost && thread.cost.amount > 0 ? ` · ${formatMoney(thread.cost)}` : ''}
                        </div>
                    )}
                    <button
                        type="button"
                        className="button button--small"
                        disabled={busy || running || thread.turns === 0}
                        title={running ? s.context.compactBusy : undefined}
                        onClick={() => void compact()}
                    >
                        <Icon name="compress" size={13} /> {busy ? s.context.compacting : s.context.compactNow}
                    </button>
                </div>
            )}
        </Popover>
    );
}
