import type { PeakWindow, PeriodRule } from './prices.ts';
import { addDays, epochOf, zonedEpoch, zonedTime } from './zone.ts';

/** Whether a vendor's peak prices apply at an instant. */
export type PeakPeriod = 'peak' | 'offpeak';

const MINUTES_PER_DAY = 24 * 60;
/** How far {@link nextPeriodChange} looks ahead: longer than any run of holidays. */
const SEARCH_DAYS = 400;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseClock(value: string): number {
    if (value === '24:00') {
        return MINUTES_PER_DAY;
    }
    const match = CLOCK.exec(value);
    if (!match) {
        throw new RangeError(`invalid clock time "${value}", expected HH:MM`);
    }
    return Number(match[1]) * 60 + Number(match[2]);
}

/** A window as `[from, to)` minutes since local midnight. */
function windowRange(window: PeakWindow): readonly [number, number] {
    const from = parseClock(window.from);
    const to = parseClock(window.to);
    if (from >= to) {
        throw new RangeError(`peak window ${window.from}-${window.to} is empty or crosses midnight`);
    }
    return [from, to];
}

/** Windows in force on a local date: none on holidays, the weekday windows on adjusted workdays. */
function windowsOn(rule: PeriodRule, date: string, weekday: number): readonly PeakWindow[] {
    if (rule.holidays?.includes(date)) {
        return [];
    }
    if (rule.workdays?.includes(date)) {
        return rule.peak.filter((window) => window.days.some((day) => day >= 1 && day <= 5));
    }
    return rule.peak.filter((window) => window.days.includes(weekday));
}

/** Peak or off-peak at `at`, judged by the wall clock in the rule's time zone. */
export function periodAt(rule: PeriodRule, at: Date): PeakPeriod {
    const local = zonedTime(rule.timezone, epochOf(at));
    const inPeak = windowsOn(rule, local.date, local.weekday).some((window) => {
        const [from, to] = windowRange(window);
        return local.minute >= from && local.minute < to;
    });
    return inPeak ? 'peak' : 'offpeak';
}

/**
 * The next instant after `at` at which the period flips, e.g. when off-peak starts for a run that should wait
 * for it. Undefined when the period does not flip within the next 400 days (no peak hours, or only peak hours).
 */
export function nextPeriodChange(rule: PeriodRule, at: Date): Date | undefined {
    const start = epochOf(at);
    if (rule.peak.length === 0) {
        return undefined;
    }
    const current = periodAt(rule, at);
    const today = zonedTime(rule.timezone, start);
    for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
        const day = addDays(today, offset);
        // The period can only change at a window edge or at midnight, when the day's windows change.
        const edges = new Set<number>([0]);
        for (const window of windowsOn(rule, day.date, day.weekday)) {
            const [from, to] = windowRange(window);
            edges.add(from);
            if (to < MINUTES_PER_DAY) {
                edges.add(to);
            }
        }
        for (const minute of [...edges].sort((a, b) => a - b)) {
            const instant = zonedEpoch(rule.timezone, day, minute);
            if (instant > start && periodAt(rule, new Date(instant)) !== current) {
                return new Date(instant);
            }
        }
    }
    return undefined;
}
