const UNITS = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
];

/** Seconds as "1d 2h 3m 4s", leaving out zero units; 0 is "0s". */
export function formatDuration(seconds) {
    if (seconds === 0) {
        return '0s';
    }
    const parts = [];
    let rest = seconds;
    for (const [unit, size] of UNITS.slice(2)) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(`${count}${unit}`);
            rest -= count * size;
        }
    }
    return parts.join(' ');
}
