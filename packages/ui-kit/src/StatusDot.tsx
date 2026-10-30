export interface StatusDotProps {
    readonly tone: 'ok' | 'pending' | 'error';
    readonly label: string;
}

export function StatusDot({ tone, label }: StatusDotProps) {
    return (
        <span className={`xk-status xk-status--${tone}`}>
            <span className="xk-status__dot" aria-hidden="true" />
            {label}
        </span>
    );
}
