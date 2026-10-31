import { zonedTime, zoneOffset } from '@xora/metering';
import { describe, expect, it } from 'vitest';
import {
    type CronSchedule,
    cronError,
    isTimeZone,
    lastCronTime,
    nextCronTime,
    parseCron,
    scheduleList,
} from '../src/index.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const iso = (value: string) => new Date(value).toISOString();
const next = (cron: string | string[], after: string, zone: string) =>
    nextCronTime(cron, new Date(after), zone)?.toISOString();
const last = (cron: string | string[], since: string, until: string, zone: string) =>
    lastCronTime(cron, new Date(since), new Date(until), zone)?.toISOString();

/** Successive fire times after `after`, as ISO strings. */
function series(cron: string, after: string, zone: string, count: number): string[] {
    const out: string[] = [];
    let at = new Date(after);
    for (let index = 0; index < count; index++) {
        const fire = nextCronTime(cron, at, zone);
        if (!fire) break;
        out.push(fire.toISOString());
        at = fire;
    }
    return out;
}

describe('parseCron', () => {
    it('reads stars, lists, ranges, steps and names', () => {
        expect(parseCron('*/15 9-17 * * MON-FRI')).toMatchObject({
            minutes: [0, 15, 30, 45],
            hours: [9, 10, 11, 12, 13, 14, 15, 16, 17],
            months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            weekdays: [1, 2, 3, 4, 5],
            matchBothDays: true,
        });
        expect(parseCron('10-50/20,5 0 1 jan,JUL *')).toMatchObject({ minutes: [5, 10, 30, 50], months: [1, 7] });
        expect(parseCron('5/15 * * * *').minutes).toEqual([5, 20, 35, 50]);
        expect(parseCron('  0   2  *  *  *  ').source).toBe('0   2  *  *  *');
        expect(parseCron('0 0 1-31/10 * *').days).toEqual([1, 11, 21, 31]);
        expect(parseCron('0 0 * FEB-APR/2 *').months).toEqual([2, 4]);
    });

    it('treats 0 and 7 as Sunday and lets a range end on Sunday', () => {
        expect(parseCron('0 0 * * 0').weekdays).toEqual([0]);
        expect(parseCron('0 0 * * 7').weekdays).toEqual([0]);
        expect(parseCron('0 0 * * 5-7').weekdays).toEqual([0, 5, 6]);
        expect(parseCron('0 0 * * FRI-SUN').weekdays).toEqual([0, 5, 6]);
        expect(parseCron('0 0 * * sat,sun').weekdays).toEqual([0, 6]);
        expect(parseCron('0 0 * * */2').weekdays).toEqual([0, 2, 4, 6]);
        expect(parseCron('0 0 * * *').weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('expands the macros', () => {
        const fields = (cron: string) => {
            const { minutes, hours, days, months, weekdays } = parseCron(cron);
            return [minutes, hours, days, months, weekdays].map((values) => values.join(','));
        };
        expect(fields('@hourly')).toEqual(fields('0 * * * *'));
        expect(fields('@daily')).toEqual(fields('0 0 * * *'));
        expect(fields('@MIDNIGHT')).toEqual(fields('0 0 * * *'));
        expect(fields('@weekly')).toEqual(fields('0 0 * * 0'));
        expect(fields('@monthly')).toEqual(fields('0 0 1 * *'));
        expect(fields('@yearly')).toEqual(fields('0 0 1 1 *'));
        expect(fields('@annually')).toEqual(fields('0 0 1 1 *'));
    });

    it('matches either day field only when both are restricted, like crontab(5)', () => {
        expect(parseCron('0 0 1,15 * MON').matchBothDays).toBe(false);
        expect(parseCron('0 0 * * MON').matchBothDays).toBe(true);
        expect(parseCron('0 0 1 * *').matchBothDays).toBe(true);
        // A field that starts with `*` counts as unrestricted even with a step.
        expect(parseCron('0 0 */2 * MON').matchBothDays).toBe(true);
    });

    it.each([
        ['0 2 * *', /expected 5 fields .* found 4/],
        ['0 2 * * * *', /found 6/],
        ['', /found 1/],
        ['60 * * * *', /minute 60 is out of range 0-59/],
        ['* 24 * * *', /hour 24 is out of range 0-23/],
        ['* * 0 * *', /day of month 0 is out of range 1-31/],
        ['* * 32 * *', /day of month 32 is out of range 1-31/],
        ['* * * 13 *', /month 13 is out of range 1-12/],
        ['* * * * 8', /day of week 8 is out of range 0-7/],
        ['*/0 * * * *', /step "0" in the minute field must be a whole number of 1 or more/],
        ['*/x * * * *', /step "x"/],
        ['5-1 * * * *', /minute range 5-1 runs backwards/],
        ['1-2-3 * * * *', /"1-2-3" is not a valid minute range/],
        ['1,,2 * * * *', /"1,,2" is not a valid minute field/],
        ['1/2/3 * * * *', /is not a valid minute field/],
        ['* * * FOO *', /"FOO" is not a month: use a number or a name like JAN/],
        ['* * * * MONDAY', /"MONDAY" is not a day of week/],
        ['MON * * * *', /"MON" is not a minute: use a number/],
        ['-1 * * * *', /is not a minute/],
        ['@reboot', /unknown macro @reboot/],
        ['0 0 30 2 *', /never fires: no month in it has day 30/],
        ['0 0 31 4,6,9,11 *', /never fires/],
    ])('rejects %j', (cron, message) => {
        expect(() => parseCron(cron)).toThrow(RangeError);
        expect(cronError(cron)).toMatch(message);
        expect(cronError(cron)).toContain(`invalid cron expression "${cron.trim()}"`);
    });

    it('accepts a day that only some months have, and day-or-weekday combinations', () => {
        expect(cronError('0 0 31 * *')).toBeUndefined();
        expect(cronError('0 0 29 2 *')).toBeUndefined();
        // Restricted on both sides: any Monday in February will do.
        expect(cronError('0 0 30 2 MON')).toBeUndefined();
    });
});

describe('time zones and schedule lists', () => {
    it('knows IANA zones', () => {
        expect(isTimeZone('Asia/Shanghai')).toBe(true);
        expect(isTimeZone('America/New_York')).toBe(true);
        expect(isTimeZone('UTC')).toBe(true);
        expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
        expect(isTimeZone('')).toBe(false);
    });

    it('turns a trigger schedule into a list', () => {
        expect(scheduleList(undefined)).toEqual([]);
        expect(scheduleList('0 2 * * *')).toEqual(['0 2 * * *']);
        expect(scheduleList(['0 2 * * *', '@hourly'])).toEqual(['0 2 * * *', '@hourly']);
    });
});

describe('nextCronTime', () => {
    const SH = 'Asia/Shanghai';

    it('finds the next time on the zone wall clock, strictly after the given instant', () => {
        expect(next('0 2 * * *', '2026-10-30T10:00:00+08:00', SH)).toBe(iso('2026-10-31T02:00:00+08:00'));
        expect(next('0 2 * * *', '2026-10-30T01:59:59.999+08:00', SH)).toBe(iso('2026-10-30T02:00:00+08:00'));
        expect(next('0 2 * * *', '2026-10-30T02:00:00+08:00', SH)).toBe(iso('2026-10-31T02:00:00+08:00'));
        expect(next('*/15 * * * *', '2026-10-30T10:07:30+08:00', SH)).toBe(iso('2026-10-30T10:15:00+08:00'));
        expect(next('*/15 * * * *', '2026-10-30T23:50:00+08:00', SH)).toBe(iso('2026-10-31T00:00:00+08:00'));
        // The same schedule in another zone: 02:00 in New York (EDT) is 14:00 in Beijing.
        expect(next('0 2 * * *', '2026-10-30T10:00:00+08:00', 'America/New_York')).toBe(
            iso('2026-10-30T02:00:00-04:00'),
        );
        expect(next('0 0 1 1 *', '2026-10-30T00:00:00Z', 'UTC')).toBe(iso('2027-01-01T00:00:00Z'));
    });

    it('skips to the next matching weekday, month and leap day', () => {
        // Friday morning: the next weekday 09:00 is on Monday.
        expect(next('0 9 * * MON-FRI', '2026-10-30T10:00:00+08:00', SH)).toBe(iso('2026-11-02T09:00:00+08:00'));
        expect(next('30 8 * * 6,0', '2026-10-27T10:00:00+08:00', SH)).toBe(iso('2026-10-31T08:30:00+08:00'));
        expect(next('0 0 1 */3 *', '2026-10-30T10:00:00+08:00', SH)).toBe(iso('2027-01-01T00:00:00+08:00'));
        expect(next('0 0 31 * *', '2026-10-31T10:00:00+08:00', SH)).toBe(iso('2026-12-31T00:00:00+08:00'));
        expect(next('0 0 29 2 *', '2026-10-30T10:00:00+08:00', SH)).toBe(iso('2028-02-29T00:00:00+08:00'));
        expect(next('@monthly', '2026-12-15T00:00:00+08:00', SH)).toBe(iso('2027-01-01T00:00:00+08:00'));
    });

    it('fires on either day field when both are restricted, on both otherwise', () => {
        // 1 November 2026 is a Sunday, 2 November a Monday.
        expect(next('0 0 1 * MON', '2026-10-27T10:00:00+08:00', SH)).toBe(iso('2026-11-01T00:00:00+08:00'));
        expect(next('0 0 1 * MON', '2026-11-01T10:00:00+08:00', SH)).toBe(iso('2026-11-02T00:00:00+08:00'));
        // `*/2` starts with a star, so both have to match: an odd day that is a Monday (2026-11-09).
        expect(next('0 0 */2 * MON', '2026-10-27T10:00:00+08:00', SH)).toBe(iso('2026-11-09T00:00:00+08:00'));
    });

    it('takes the earliest of several schedules', () => {
        expect(next(['0 2 * * *', '30 1 * * *'], '2026-10-30T10:00:00+08:00', SH)).toBe(
            iso('2026-10-31T01:30:00+08:00'),
        );
        expect(next([], '2026-10-30T10:00:00+08:00', SH)).toBeUndefined();
    });

    it('moves a time skipped by the spring-forward jump one hour later (America/New_York)', () => {
        const NY = 'America/New_York';
        // 2026-03-08: at 02:00 EST (07:00Z) clocks jump to 03:00 EDT, so 02:30 does not exist and runs at 03:30.
        expect(next('30 2 * * *', '2026-03-07T12:00:00-05:00', NY)).toBe('2026-03-08T07:30:00.000Z');
        expect(next('30 2 * * *', '2026-03-08T07:30:00Z', NY)).toBe(iso('2026-03-09T02:30:00-04:00'));
        // Asked from inside the moved hour, the moved time is still ahead.
        expect(next('30 2 * * *', '2026-03-08T03:10:00-04:00', NY)).toBe('2026-03-08T07:30:00.000Z');
        // Hourly and half-hourly schedules neither lose nor double a run: the moved times merge with real ones.
        expect(series('0 * * * *', '2026-03-08T05:30:00Z', NY, 3)).toEqual([
            '2026-03-08T06:00:00.000Z',
            '2026-03-08T07:00:00.000Z',
            '2026-03-08T08:00:00.000Z',
        ]);
        expect(series('*/30 * * * *', '2026-03-08T06:00:00Z', NY, 4)).toEqual([
            '2026-03-08T06:30:00.000Z',
            '2026-03-08T07:00:00.000Z',
            '2026-03-08T07:30:00.000Z',
            '2026-03-08T08:00:00.000Z',
        ]);
    });

    it('runs a time repeated by the fall-back jump once, at its first occurrence (America/New_York)', () => {
        const NY = 'America/New_York';
        // 2026-11-01: at 02:00 EDT (06:00Z) clocks go back to 01:00 EST, so 01:30 happens at 05:30Z and 06:30Z.
        expect(next('30 1 * * *', '2026-10-31T12:00:00-04:00', NY)).toBe('2026-11-01T05:30:00.000Z');
        expect(next('30 1 * * *', '2026-11-01T05:30:00Z', NY)).toBe(iso('2026-11-02T01:30:00-05:00'));
        // From inside the second pass the repeated time is over for the day.
        expect(next('45 1 * * *', '2026-11-01T06:15:00Z', NY)).toBe(iso('2026-11-02T01:45:00-05:00'));
        expect(series('*/30 * * * *', '2026-11-01T04:45:00Z', NY, 4)).toEqual([
            '2026-11-01T05:00:00.000Z',
            '2026-11-01T05:30:00.000Z',
            '2026-11-01T07:00:00.000Z',
            '2026-11-01T07:30:00.000Z',
        ]);
    });

    it('moves a skipped late-evening time past midnight (America/Nuuk jumps from 23:00 to 00:00)', () => {
        const NUUK = 'America/Nuuk';
        // Saturday 2026-03-28 23:00 (-02) becomes Sunday 00:00 (-01) at 01:00Z: 23:30 runs as Sunday 00:30.
        expect(next('30 23 * * *', '2026-03-28T12:00:00Z', NUUK)).toBe('2026-03-29T01:30:00.000Z');
        expect(next('30 23 * * *', '2026-03-29T01:30:00Z', NUUK)).toBe(iso('2026-03-29T23:30:00-01:00'));
        // Sunday's own 00:30 is the same instant: one run, not two.
        expect(series('30 0,23 * * *', '2026-03-28T12:00:00Z', NUUK, 2)).toEqual([
            '2026-03-29T01:30:00.000Z',
            iso('2026-03-29T23:30:00-01:00'),
        ]);
        expect(last('30 23 * * 6', '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z', NUUK)).toBe(
            '2026-03-29T01:30:00.000Z',
        );
    });

    it('never moves in Asia/Shanghai, which has no daylight saving time', () => {
        expect(series('30 2 * * *', '2026-03-07T00:00:00+08:00', SH, 3)).toEqual([
            iso('2026-03-07T02:30:00+08:00'),
            iso('2026-03-08T02:30:00+08:00'),
            iso('2026-03-09T02:30:00+08:00'),
        ]);
    });

    it('rejects bad input', () => {
        expect(() => nextCronTime('61 * * * *', new Date(), SH)).toThrow(RangeError);
        expect(() => nextCronTime('0 2 * * *', new Date(Number.NaN), SH)).toThrow(RangeError);
        expect(() => nextCronTime('0 2 * * *', new Date(), 'Mars/Olympus_Mons')).toThrow(RangeError);
    });
});

describe('lastCronTime', () => {
    const SH = 'Asia/Shanghai';

    it('finds the latest time in (since, until] for a run missed while the app was closed', () => {
        expect(last('0 2 * * *', '2026-10-27T03:00:00+08:00', '2026-10-30T10:00:00+08:00', SH)).toBe(
            iso('2026-10-30T02:00:00+08:00'),
        );
        expect(last('0 2 * * *', '2026-10-30T02:30:00+08:00', '2026-10-30T10:00:00+08:00', SH)).toBeUndefined();
        // `since` is excluded, `until` included.
        expect(last('0 2 * * *', '2026-10-30T02:00:00+08:00', '2026-10-31T01:59:00+08:00', SH)).toBeUndefined();
        expect(last('0 2 * * *', '2026-10-29T02:00:00+08:00', '2026-10-30T02:00:00+08:00', SH)).toBe(
            iso('2026-10-30T02:00:00+08:00'),
        );
        expect(last('0 2 * * *', '2026-10-30T10:00:00+08:00', '2026-10-30T10:00:00+08:00', SH)).toBeUndefined();
    });

    it('sees through weekends, month ends and several schedules', () => {
        // Closed from Friday evening to Monday 08:00: no weekday run was missed, the Sunday one was.
        const since = '2026-10-30T18:00:00+08:00';
        const until = '2026-11-02T08:00:00+08:00';
        expect(last('0 9 * * MON-FRI', since, until, SH)).toBeUndefined();
        expect(last('0 10 * * *', since, until, SH)).toBe(iso('2026-11-01T10:00:00+08:00'));
        expect(last(['0 10 * * *', '0 7 * * MON'], since, until, SH)).toBe(iso('2026-11-02T07:00:00+08:00'));
        expect(last('0 0 1 * *', '2026-08-15T00:00:00+08:00', until, SH)).toBe(iso('2026-11-01T00:00:00+08:00'));
        expect(last('0 0 29 2 *', '2023-01-01T00:00:00+08:00', until, SH)).toBe(iso('2024-02-29T00:00:00+08:00'));
    });

    it('follows the same daylight saving rules as nextCronTime', () => {
        const NY = 'America/New_York';
        expect(last('30 2 * * *', '2026-03-07T12:00:00-05:00', '2026-03-08T12:00:00-04:00', NY)).toBe(
            '2026-03-08T07:30:00.000Z',
        );
        expect(last('30 1 * * *', '2026-10-31T12:00:00-04:00', '2026-11-01T12:00:00-05:00', NY)).toBe(
            '2026-11-01T05:30:00.000Z',
        );
        // The second 01:30 is not a run of its own.
        expect(last('30 1 * * *', '2026-11-01T05:30:00Z', '2026-11-01T12:00:00-05:00', NY)).toBeUndefined();
    });
});

// Cross-check against the real clock ----------------------------------------------------------------------

/** The wall-clock minute an instant shows in `zone`, encoded as if it were UTC. */
function wallOf(zone: string, instant: number): number {
    const local = zonedTime(zone, instant);
    return Date.UTC(local.year, local.month - 1, local.day) + local.minute * MINUTE;
}

function wallMatches(schedule: CronSchedule, wall: number): boolean {
    const at = new Date(wall);
    if (
        !schedule.minutes.includes(at.getUTCMinutes()) ||
        !schedule.hours.includes(at.getUTCHours()) ||
        !schedule.months.includes(at.getUTCMonth() + 1)
    ) {
        return false;
    }
    const date = schedule.days.includes(at.getUTCDate());
    const weekday = schedule.weekdays.includes(at.getUTCDay());
    return schedule.matchBothDays ? date && weekday : date || weekday;
}

/** The first instant that shows each wall-clock minute, walking every minute of real time around the window. */
function wallClockWalk(zone: string, from: number, to: number): Map<number, number> {
    const firstSeen = new Map<number, number>();
    for (let instant = from - DAY; instant <= to + DAY; instant += MINUTE) {
        const wall = wallOf(zone, instant);
        if (!firstSeen.has(wall)) firstSeen.set(wall, instant);
    }
    return firstSeen;
}

/**
 * The fires in `(from, to]` from the walk: a wall minute runs at the first instant that shows it; one that never
 * shows (skipped by a jump) runs with the offset from before the jump.
 */
function referenceFires(cron: string, firstSeen: Map<number, number>, from: number, to: number): number[] {
    const schedule = parseCron(cron);
    const walls = [...firstSeen.keys()];
    const [lowest, highest] = [Math.min(...walls), Math.max(...walls)];
    const fires = new Set<number>();
    let offsetBefore = 0;
    for (let wall = lowest; wall <= highest; wall += MINUTE) {
        const seen = firstSeen.get(wall);
        if (seen !== undefined) offsetBefore = wall - seen;
        if (wallMatches(schedule, wall)) fires.add(seen ?? wall - offsetBefore);
    }
    return [...fires].filter((instant) => instant > from && instant <= to).sort((a, b) => a - b);
}

describe('cron times against a minute-by-minute walk of the clock', () => {
    const SCHEDULES = [
        '*/30 * * * *',
        '15 */2 * * *',
        '0 0 * * *',
        '30 2 * * *',
        '59 23 * * *',
        '0,30 0-3 * * *',
        '45 1 * * *',
        '0 2 * * 0',
        '30 23 * * 6',
    ];
    // Jumps of an hour at 02:00, at 01:00 UTC, at midnight (Santiago), at 23:00 (Nuuk) and of half an hour
    // (Lord Howe); Shanghai has none.
    const WINDOWS: Array<[string, string]> = [
        ['America/New_York', '2026-03-08T12:00:00Z'],
        ['America/New_York', '2026-11-01T12:00:00Z'],
        ['Europe/London', '2026-03-29T12:00:00Z'],
        ['Europe/London', '2026-10-25T12:00:00Z'],
        ['America/Santiago', '2026-04-05T12:00:00Z'],
        ['America/Santiago', '2026-09-06T12:00:00Z'],
        ['America/Nuuk', '2026-03-29T01:00:00Z'],
        ['America/Nuuk', '2026-10-25T01:00:00Z'],
        ['Australia/Lord_Howe', '2026-04-05T00:00:00Z'],
        ['Australia/Lord_Howe', '2026-10-04T00:00:00Z'],
        ['Asia/Shanghai', '2026-10-30T00:00:00Z'],
    ];

    it.each(WINDOWS)('%s around %s', (zone, around) => {
        const from = Date.parse(around) - 2 * DAY;
        const to = Date.parse(around) + 2 * DAY;
        // The window really holds a jump (or, for Shanghai, really none).
        expect(zoneOffset(zone, from) !== zoneOffset(zone, to)).toBe(zone !== 'Asia/Shanghai');
        const walk = wallClockWalk(zone, from, to);
        for (const cron of SCHEDULES) {
            const expected = referenceFires(cron, walk, from, to);
            const actual: number[] = [];
            for (let at = nextCronTime(cron, from, zone); at && at.getTime() <= to; at = nextCronTime(cron, at, zone)) {
                actual.push(at.getTime());
            }
            expect(
                actual.map((t) => new Date(t).toISOString()),
                `${cron} in ${zone}`,
            ).toEqual(expected.map((t) => new Date(t).toISOString()));
            // Walking back gives the same times.
            for (const [position, fire] of expected.entries()) {
                expect(lastCronTime(cron, from, fire, zone)?.getTime(), `${cron} in ${zone}`).toBe(fire);
                expect(lastCronTime(cron, from, fire - 1, zone)?.getTime(), `${cron} in ${zone}`).toBe(
                    expected[position - 1],
                );
            }
        }
    });
});
