import { randomBytes } from 'node:crypto';

let lastTime = 0;
let counter = 0;

/**
 * Sortable ids: base36 time plus a counter and random suffix, e.g. `t_lr8k2c0a1x3f9q`. Sorting by id sorts by
 * creation time, which keeps listings stable without an extra column.
 */
export function newId(prefix: string): string {
    const now = Date.now();
    if (now === lastTime) {
        counter++;
    } else {
        lastTime = now;
        counter = 0;
    }
    const time = now.toString(36).padStart(9, '0');
    const sequence = counter.toString(36).padStart(2, '0');
    return `${prefix}_${time}${sequence}${randomBytes(4).toString('hex')}`;
}
