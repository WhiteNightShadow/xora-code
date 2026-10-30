/**
 * Calendar arithmetic in an IANA time zone with nothing but `Intl.DateTimeFormat`. Civil dates are plain
 * `{year, month, day}` values; instants are epoch milliseconds.
 */

export interface CivilDate {
    readonly year: number;
    /** 1–12. */
    readonly month: number;
    readonly day: number;
}

export interface CivilDay extends CivilDate {
    /** `YYYY-MM-DD`. */
    readonly date: string;
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    readonly weekday: number;
}

export interface ZonedTime extends CivilDay {
    /** Minutes since local midnight. */
    readonly minute: number;
}

interface WallClock extends CivilDate {
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let cached = formatters.get(timeZone);
    if (!cached) {
        cached = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });
        formatters.set(timeZone, cached);
    }
    return cached;
}

function wallClock(timeZone: string, epochMs: number): WallClock {
    const fields: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
    for (const part of formatter(timeZone).formatToParts(epochMs)) {
        if (part.type !== 'literal') {
            fields[part.type] = Number(part.value);
        }
    }
    return {
        year: fields.year ?? 0,
        month: fields.month ?? 0,
        day: fields.day ?? 0,
        hour: fields.hour ?? 0,
        minute: fields.minute ?? 0,
        second: fields.second ?? 0,
    };
}

/** Offset of the zone's wall clock from UTC at an instant, in milliseconds. */
function offsetAt(timeZone: string, epochMs: number): number {
    const clock = wallClock(timeZone, epochMs);
    const wall = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
    // The formatted clock has no milliseconds, so compare against the instant truncated to the second.
    return wall - (epochMs - (((epochMs % 1000) + 1000) % 1000));
}

/** Normalises an overflowing date (day 0, day 32, month 13 …) and adds its `YYYY-MM-DD` form and weekday. */
export function civilDay(year: number, month: number, day: number): CivilDay {
    const utc = new Date(Date.UTC(year, month - 1, day));
    const normalised = { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
    const pad = (value: number, width: number) => String(value).padStart(width, '0');
    return {
        ...normalised,
        date: `${pad(normalised.year, 4)}-${pad(normalised.month, 2)}-${pad(normalised.day, 2)}`,
        weekday: utc.getUTCDay() || 7,
    };
}

export function addDays(date: CivilDate, days: number): CivilDay {
    return civilDay(date.year, date.month, date.day + days);
}

/** Local date, weekday and minute of an instant in `timeZone`. */
export function zonedTime(timeZone: string, epochMs: number): ZonedTime {
    const clock = wallClock(timeZone, epochMs);
    return { ...civilDay(clock.year, clock.month, clock.day), minute: clock.hour * 60 + clock.minute };
}

/**
 * The instant at which `timeZone`'s wall clock shows `minuteOfDay` on `date`. The second pass corrects for an
 * offset change between the guess and the target; a time skipped by a DST jump resolves to a nearby instant.
 */
export function zonedEpoch(timeZone: string, date: CivilDate, minuteOfDay = 0): number {
    const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
    const guess = wall - offsetAt(timeZone, wall);
    return wall - offsetAt(timeZone, guess);
}

export function epochOf(at: Date): number {
    const epochMs = at.getTime();
    if (!Number.isFinite(epochMs)) {
        throw new RangeError('invalid date');
    }
    return epochMs;
}
