import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useEffect, useRef } from 'react';
import { EmptyArt } from './Art.tsx';
import { Icon, type IconName } from './Icon.tsx';

export function IconButton({
    icon,
    label,
    onClick,
    active,
    disabled,
    size = 16,
    tone,
}: {
    icon: IconName;
    label: string;
    onClick?: () => void;
    active?: boolean;
    disabled?: boolean;
    size?: number;
    tone?: 'danger';
}) {
    return (
        <button
            type="button"
            className={`icon-button${active ? ' is-active' : ''}${tone ? ` is-${tone}` : ''}`}
            title={label}
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            onClick={onClick}
        >
            <Icon name={icon} size={size} />
        </button>
    );
}

export interface Option<T extends string> {
    readonly value: T;
    readonly label: string;
    readonly hint?: string;
}

export function Select<T extends string>({
    value,
    options,
    onChange,
    label,
    disabled,
    compact,
}: {
    value: T | '';
    options: readonly Option<T>[];
    onChange: (value: T) => void;
    label: string;
    disabled?: boolean;
    compact?: boolean;
}) {
    return (
        <select
            className={`select${compact ? ' select--compact' : ''}`}
            aria-label={label}
            title={options.find((option) => option.value === value)?.hint ?? label}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value as T)}
        >
            {value === '' && <option value="">—</option>}
            {options.map((option) => (
                <option key={option.value} value={option.value} title={option.hint}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

export function Toggle({
    checked,
    onChange,
    label,
    text,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: string;
    /** Visible text when it differs from the accessible label (a table row's switch shows "enabled"). */
    text?: string;
}) {
    return (
        <label className="toggle">
            <input
                type="checkbox"
                checked={checked}
                aria-label={text === undefined ? undefined : label}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span>{text ?? label}</span>
        </label>
    );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="field">
            <div className="field__label">{label}</div>
            <div className="field__control">{children}</div>
            {hint && <div className="field__hint">{hint}</div>}
        </div>
    );
}

export function Modal({
    title,
    onClose,
    children,
    wide,
}: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        ref.current?.focus();
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="modal-backdrop">
            <button
                type="button"
                className="modal-backdrop__dismiss"
                aria-label="关闭"
                tabIndex={-1}
                onClick={onClose}
            />
            <div
                className={`modal${wide ? ' modal--wide' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                ref={ref}
            >
                <div className="modal__header">
                    <h2>{title}</h2>
                    <IconButton icon="x" label="关闭" onClick={onClose} />
                </div>
                <div className="modal__body">{children}</div>
            </div>
        </div>
    );
}

export function Spinner({ size = 12 }: { size?: number }) {
    return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Badge({
    children,
    tone,
}: {
    children: ReactNode;
    tone?: 'ok' | 'warn' | 'error' | 'accent' | 'muted';
}) {
    return <span className={`badge${tone ? ` badge--${tone}` : ''}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
    // The picture is hidden by the stylesheet when the empty state only holds a spinner.
    return (
        <div className="empty">
            <EmptyArt className="empty__art" />
            {children}
        </div>
    );
}

/** Formats a money amount: ¥0.42, $1.20; tiny amounts keep more digits. */
export function formatMoney(money: { amount: number; currency: string } | null | undefined): string {
    if (!money) return '—';
    const symbol = money.currency === 'USD' ? '$' : money.currency === 'CNY' ? '¥' : `${money.currency} `;
    const digits = money.amount !== 0 && Math.abs(money.amount) < 0.01 ? 4 : 2;
    return `${symbol}${money.amount.toFixed(digits)}`;
}

export function formatTokens(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return String(count);
}

export function relativeTime(ts: number, now = Date.now()): string {
    const seconds = Math.round((now - ts) / 1000);
    if (seconds < 60) return '刚刚';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(ts).toLocaleDateString();
}

/** Focuses the element once when it mounts, for inputs that appear because the user asked for them. */
export function useFocusOnMount<T extends HTMLElement>(): React.RefObject<T | null> {
    const ref = useRef<T>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return ref;
}

/** An input that takes focus when it appears (inline editors the user just opened). */
export function AutoFocusInput(props: InputHTMLAttributes<HTMLInputElement>) {
    const ref = useFocusOnMount<HTMLInputElement>();
    return <input ref={ref} {...props} />;
}

export function AutoFocusTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    const ref = useFocusOnMount<HTMLTextAreaElement>();
    return <textarea ref={ref} {...props} />;
}
