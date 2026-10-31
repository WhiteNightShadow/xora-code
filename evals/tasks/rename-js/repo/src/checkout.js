import { calcTotal } from './cart.js';

export function checkout(cart, payment) {
    const total = calcTotal(cart.lines);
    if (payment.amount < total) {
        return { ok: false, missing: Math.round((total - payment.amount) * 100) / 100 };
    }
    return { ok: true, change: Math.round((payment.amount - total) * 100) / 100 };
}
