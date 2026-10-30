import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    readonly variant?: 'primary' | 'secondary' | 'danger';
}

export function Button({ variant = 'secondary', className, type = 'button', ...rest }: ButtonProps) {
    const classes = ['xk-button', `xk-button--${variant}`, className].filter(Boolean).join(' ');
    return <button type={type} className={classes} {...rest} />;
}
