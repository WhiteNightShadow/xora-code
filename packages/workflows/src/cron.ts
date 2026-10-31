import { addDays, type CivilDay, civilDay, zonedTime, zoneOffset } from '@xora/metering';

/**
 * Cron schedules of workflow triggers (06 §12): five fields — minute, hour, day of month, month, day of week —
 * read on the wall clock of an IANA time zone.
 *
 * - A field is `*`, a number, a range `a-b`, either of them with a step (`a-b/n`, or `*` followed by `/n`), or a
 *   comma list of those; `a/n` runs from `a` to the end of the field. Months take JAN–DEC, days of the week
 *   SUN–SAT; 0 and 7 are both Sunday, and a range may end on Sunday (`FRI-SUN`).
 * - `@hourly`, `@daily` (`@midnight`), `@weekly`, `@monthly` and `@yearly` (`@annually`) stand for the usual
 *   expressions.
 * - As in crontab(5), when both day fields are restricted (neither starts with `*`) a day matches either of
 *   them; otherwise it has to match both.
 * - Daylight saving time follows RFC 5545 (and Temporal's `compatible` disambiguation). A wall time skipped by a
 *   jump forward is read with the offset from before the jump, so it runs one jump later (02:30 → 03:30 in New
 *   York) and merges with a time the schedule has there anyway; a wall time repeated by a jump back runs at its
 *   first occurrence only. Daily schedules neither lose a day nor run twice, and hourly ones do not double up.
 */

export interface CronSchedule {
    /** The expression as written. */
    readonly source: string;
    /** Sorted values of each field. */
    readonly minutes: readonly number[];
    readonly hours: readonly number[];
    readonly days: readonly number[];
    readonly months: readonly number[];
    /** 0 = Sunday … 6 = Saturday. */
    readonly weekdays: readonly number[];
    /** Whether a day has to match both day fields (one of them starts with `*`), or only one of them. */
    readonly matchBothDays: boolean;
}

/** A schedule, or several of them (a trigger's `schedule` list), as expressions or parsed. */
export type CronInput = string | CronSchedule | readonly (string | CronSchedule)[];

const MACROS: Readonly<Record<string, string>> = {
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** Longest month by month number; February has its leap day. */
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface FieldSpec {
    readonly name: string;
    readonly min: number;
    readonly max: number;
    /** Names of the values from `min` on. */
    readonly names?: readonly string[];
}

const FIELDS: readonly [FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec] = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
    { name: 'day of week', min: 0, max: 7, names: DAY_NAMES },
];
const WEEKDAY_FIELD = FIELDS[4];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** How far the searches look; even a 29 February that has to fall on a given weekday comes round sooner. */
const HORIZON_DAYS = 50 * 366;

class CronSyntaxError extends Error {}

function fieldValue(text: string, field: FieldSpec): number {
    if (/^\d+$/.test(text)) {
        return Number(text);
    }
    const named = field.names?.indexOf(text.toUpperCase()) ?? -1;
    if (named < 0) {
        throw new CronSyntaxError(
            field.names
                ? `"${text}" is not a ${field.name}: use a number or a name like ${field.names[0]}`
                : `"${text}" is not a ${field.name}: use a number`,
        );
    }
    return named + field.min;
}

function parseField(text: string, field: FieldSpec): number[] {
    const weekday = field === WEEKDAY_FIELD;
    // `*` and an open range end at Saturday: Sunday is already there as 0.
    const top = weekday ? 6 : field.max;
    const values = new Set<number>();
    for (const item of text.split(',')) {
        const [range = '', stepText, extra] = item.split('/');
        if (item === '' || range === '' || extra !== undefined) {
            throw new CronSyntaxError(`"${text}" is not a valid ${field.name} field`);
        }
        let step = 1;
        if (stepText !== undefined) {
            step = /^\d+$/.test(stepText) ? Number(stepText) : 0;
            if (step < 1) {
                throw new CronSyntaxError(
                    `step "${stepText}" in the ${field.name} field must be a whole number of 1 or more`,
                );
            }
        }
        let low: number;
        let high: number;
        if (range === '*') {
            low = field.min;
            high = top;
        } else if (range.includes('-')) {
            const [from = '', to = '', more] = range.split('-');
            if (more !== undefined) {
                throw new CronSyntaxError(`"${range}" is not a valid ${field.name} range`);
            }
            low = fieldValue(from, field);
            high = fieldValue(to, field);
            if (weekday && high === 0 && low > 0) {
                high = 7;
            }
        } else {
            low = fieldValue(range, field);
            high = stepText === undefined ? low : top;
        }
        for (const value of [low, high]) {
            if (value < field.min || value > field.max) {
                throw new CronSyntaxError(`${field.name} ${value} is out of range ${field.min}-${field.max}`);
            }
        }
        if (low > high) {
            throw new CronSyntaxError(`${field.name} range ${range} runs backwards`);
        }
        for (let value = low; value <= high; value += step) {
            values.add(weekday && value === 7 ? 0 : value);
        }
    }
    return [...values].sort((a, b) => a - b);
}

/** Reads a cron expression; throws a `RangeError` that says what is wrong with it. */
export function parseCron(expression: string): CronSchedule {
    const source = expression.trim();
    try {
        const text = source.startsWith('@') ? MACROS[source.toLowerCase()] : source;
        if (text === undefined) {
            throw new CronSyntaxError(`unknown macro ${source}: use ${Object.keys(MACROS).join(', ')}`);
        }
        const parts = text.split(/\s+/);
        if (parts.length !== 5) {
            throw new CronSyntaxError(
                `expected 5 fields (minute hour day-of-month month day-of-week), found ${parts.length}`,
            );
        }
        const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
        const schedule: CronSchedule = {
            source,
            minutes: parseField(minute, FIELDS[0]),
            hours: parseField(hour, FIELDS[1]),
            days: parseField(day, FIELDS[2]),
            months: parseField(month, FIELDS[3]),
            weekdays: parseField(weekday, FIELDS[4]),
            matchBothDays: day.startsWith('*') || weekday.startsWith('*'),
        };
        // Restricted days have to exist in one of the months, or nothing would ever match (30 February).
        const exists = (m: number) => schedule.days.some((d) => d <= (MONTH_DAYS[m] ?? 0));
        if (schedule.matchBothDays && !schedule.months.some(exists)) {
            throw new CronSyntaxError(`it never fires: no month in it has day ${schedule.days.join(',')}`);
        }
        return Object.freeze(schedule);
    } catch (error) {
        if (error instanceof CronSyntaxError) {
            throw new RangeError(`invalid cron expression "${source}": ${error.message}`);
        }
        throw error;
    }
}

/** What is wrong with a cron expression, or undefined when it is fine. */
export function cronError(expression: string): string | undefined {
    try {
        parseCron(expression);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Whether `Intl` knows the time zone (`Asia/Shanghai`, `UTC` …). */
export function isTimeZone(timeZone: string): boolean {
    if (timeZone.trim() === '') {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
}

/** The system's time zone, which schedules without `timezone` use. */
export function systemTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The expressions of a trigger's `schedule`: none, one or a list. */
export function scheduleList(schedule: string | readonly string[] | undefined): string[] {
    return schedule === undefined ? [] : typeof schedule === 'string' ? [schedule] : [...schedule];
}

function isList(cron: CronInput): cron is readonly (string | CronSchedule)[] {
    return Array.isArray(cron);
}

function schedulesOf(cron: CronInput): CronSchedule[] {
    return (isList(cron) ? cron : [cron]).map((item) => (typeof item === 'string' ? parseCron(item) : item));
}

function epochOf(at: Date | number): number {
    const epochMs = typeof at === 'number' ? at : at.getTime();
    if (!Number.isFinite(epochMs)) {
        throw new RangeError('invalid date');
    }
    return epochMs;
}

function dayMatches(schedule: CronSchedule, day: CivilDay): boolean {
    if (!schedule.months.includes(day.month)) {
        return false;
    }
    const date = schedule.days.includes(day.day);
    const weekday = schedule.weekdays.includes(day.weekday % 7);
    return schedule.matchBothDays ? date && weekday : date || weekday;
}

/** The first minute after `from` whose offset differs from `offset`, `from` having `offset` and `to` not. */
function offsetChange(timeZone: string, from: number, to: number, offset: number): number {
    let low = from;
    let high = to;
    while (high - low > MINUTE_MS) {
        const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
        if (zoneOffset(timeZone, middle) === offset) {
            low = middle;
        } else {
            high = middle;
        }
    }
    return high;
}

/**
 * The instants at which a matching day fires, ascending and without duplicates, and whether a time had to move
 * because a jump forward skipped it (it may then land after the next day's first time).
 */
function dayFires(schedule: CronSchedule, timeZone: string, day: CivilDay): { fires: number[]; moved: boolean } {
    // The day's wall-clock midnight read as UTC; offsets lie within -12 h…+14 h, so these two instants fall
    // before the day starts and after it ends anywhere.
    const midnight = Date.UTC(day.year, day.month - 1, day.day);
    const from = midnight - 15 * HOUR_MS;
    const to = midnight + DAY_MS + 15 * HOUR_MS;
    const before = zoneOffset(timeZone, from);
    const after = zoneOffset(timeZone, to);
    const fires: number[] = [];
    if (before === after) {
        for (const hour of schedule.hours) {
            for (const minute of schedule.minutes) {
                fires.push(midnight + hour * HOUR_MS + minute * MINUTE_MS - before);
            }
        }
        return { fires, moved: false };
    }
    // The offset changes around this day: place every time against the moment it changes.
    const change = offsetChange(timeZone, from, to, before);
    const instants = new Set<number>();
    let moved = false;
    for (const hour of schedule.hours) {
        for (const minute of schedule.minutes) {
            const wall = midnight + hour * HOUR_MS + minute * MINUTE_MS;
            const early = wall - before;
            const late = wall - after;
            const earlyExists = early < change;
            const lateExists = late >= change;
            if (earlyExists && lateExists) {
                // Repeated by a jump back: the first occurrence.
                instants.add(Math.min(early, late));
            } else if (earlyExists || lateExists) {
                instants.add(earlyExists ? early : late);
            } else {
                // Skipped by a jump forward: read with the offset from before the jump.
                instants.add(early);
                moved = true;
            }
        }
    }
    return { fires: [...instants].sort((a, b) => a - b), moved };
}

function firstAfter(schedule: CronSchedule, timeZone: string, day: CivilDay, start: number) {
    const { fires, moved } = dayFires(schedule, timeZone, day);
    return { hit: fires.find((instant) => instant > start), moved };
}

function nextOf(schedule: CronSchedule, timeZone: string, start: number): number | undefined {
    // Begin a day early: a time skipped late on the day before can run after `start`.
    let day = addDays(zonedTime(timeZone, start), -1);
    const end = addDays(day, HORIZON_DAYS).date;
    while (day.date <= end) {
        if (!schedule.months.includes(day.month)) {
            day = civilDay(day.year, day.month + 1, 1);
            continue;
        }
        if (dayMatches(schedule, day)) {
            const { hit, moved } = firstAfter(schedule, timeZone, day, start);
            if (hit !== undefined) {
                const next = addDays(day, 1);
                if (moved && dayMatches(schedule, next)) {
                    const other = firstAfter(schedule, timeZone, next, start).hit;
                    return other !== undefined && other < hit ? other : hit;
                }
                return hit;
            }
        }
        day = addDays(day, 1);
    }
    return undefined;
}

function lastOf(schedule: CronSchedule, timeZone: string, since: number, until: number): number | undefined {
    const latest = (day: CivilDay) =>
        dayFires(schedule, timeZone, day)
            .fires.filter((instant) => instant > since && instant <= until)
            .at(-1);
    const stop = addDays(zonedTime(timeZone, since), -1).date;
    let day = addDays(zonedTime(timeZone, until), 1);
    while (day.date >= stop) {
        if (!schedule.months.includes(day.month)) {
            day = civilDay(day.year, day.month, 0);
            continue;
        }
        if (dayMatches(schedule, day)) {
            const hit = latest(day);
            if (hit !== undefined) {
                // A time skipped late on the day before can run after this day's last time.
                const previous = addDays(day, -1);
                const other = dayMatches(schedule, previous) ? latest(previous) : undefined;
                return other !== undefined && other > hit ? other : hit;
            }
        }
        day = addDays(day, -1);
    }
    return undefined;
}

/**
 * The first time after `after` (exclusive) at which the schedule fires, in `timeZone` (the system's by default);
 * the earliest of several schedules. Undefined when it does not fire within the next fifty years.
 */
export function nextCronTime(cron: CronInput, after: Date | number, timeZone = systemTimeZone()): Date | undefined {
    const start = epochOf(after);
    let best: number | undefined;
    for (const schedule of schedulesOf(cron)) {
        const next = nextOf(schedule, timeZone, start);
        if (next !== undefined && (best === undefined || next < best)) {
            best = next;
        }
    }
    return best === undefined ? undefined : new Date(best);
}

/**
 * The latest time in `(since, until]` at which the schedule fires (the latest of several schedules), e.g. the run
 * missed while the app was closed. Undefined when there is none.
 */
export function lastCronTime(
    cron: CronInput,
    since: Date | number,
    until: Date | number,
    timeZone = systemTimeZone(),
): Date | undefined {
    const from = epochOf(since);
    const to = epochOf(until);
    if (to <= from) {
        return undefined;
    }
    let best: number | undefined;
    for (const schedule of schedulesOf(cron)) {
        const last = lastOf(schedule, timeZone, from, to);
        if (last !== undefined && (best === undefined || last > best)) {
            best = last;
        }
    }
    return best === undefined ? undefined : new Date(best);
}
