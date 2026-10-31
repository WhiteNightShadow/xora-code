/** Integers from start to end, both included, stepping by `step` (1 by default, negative to count down). */
export function range(start, end, step = 1) {
    if (step === 0) {
        throw new Error('step must not be 0');
    }
    const out = [];
    if (step > 0) {
        for (let i = start; i < end; i += step) out.push(i);
    } else {
        for (let i = start; i > end; i += step) out.push(i);
    }
    return out;
}

/** Splits items into chunks of `size`; the last chunk holds what is left. */
export function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length - size; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}
