import { describe, expect, it } from 'vitest';
import { nextPeriodChange, offPeakStart, type PeriodRule, periodAt } from '../src/index.ts';
import { deepseekRule } from './helpers.ts';

const rule = deepseekRule();
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

describe('periodAt', () => {
    it.each([
        ['2026-10-26T08:59:59.999+08:00', 'offpeak'],
        ['2026-10-26T09:00:00+08:00', 'peak'],
        ['2026-10-26T11:59:59.999+08:00', 'peak'],
        ['2026-10-26T12:00:00+08:00', 'offpeak'],
        ['2026-10-26T13:59:59+08:00', 'offpeak'],
        ['2026-10-26T14:00:00+08:00', 'peak'],
        ['2026-10-26T17:59:59+08:00', 'peak'],
        ['2026-10-26T18:00:00+08:00', 'offpeak'],
    ])('Monday %s Beijing time is %s (from inclusive, to exclusive)', (iso, expected) => {
        expect(periodAt(rule, new Date(iso))).toBe(expected);
    });

    it('reads the Beijing wall clock however the instant is written', () => {
        // Monday 09:00 in Beijing, written in UTC, in New York (still Sunday there), in Los Angeles and in Tokyo.
        for (const iso of [
            '2026-10-26T01:00:00Z',
            '2026-10-25T21:00:00-04:00',
            '2026-10-25T18:00:00-07:00',
            '2026-10-26T10:00:00+09:00',
        ]) {
            expect(periodAt(rule, new Date(iso))).toBe('peak');
        }
        // One minute earlier it is still off-peak.
        expect(periodAt(rule, new Date('2026-10-26T00:59:00Z'))).toBe('offpeak');
    });

    it('takes the weekday from the rule zone, not from UTC', () => {
        const saturdayNight: PeriodRule = {
            timezone: 'Asia/Shanghai',
            peak: [{ days: [6], from: '00:00', to: '02:00' }],
            offPeakMultiplier: 0.5,
        };
        // Friday 17:00 UTC is Saturday 01:00 in Beijing.
        expect(periodAt(saturdayNight, new Date('2026-10-30T17:00:00Z'))).toBe('peak');
        // Saturday 17:00 UTC is already Sunday 01:00 in Beijing.
        expect(periodAt(saturdayNight, new Date('2026-10-31T17:00:00Z'))).toBe('offpeak');
    });

    it('treats weekends as off-peak', () => {
        expect(periodAt(rule, new Date('2026-10-31T10:00:00+08:00'))).toBe('offpeak');
        expect(periodAt(rule, new Date('2026-11-01T15:00:00+08:00'))).toBe('offpeak');
    });

    it('treats holidays as off-peak all day', () => {
        const thursday = new Date('2026-10-01T10:00:00+08:00');
        expect(periodAt(rule, thursday)).toBe('peak');
        expect(periodAt({ ...rule, holidays: ['2026-10-01'] }, thursday)).toBe('offpeak');
    });

    it('applies the weekday windows on adjusted weekend workdays', () => {
        const workday = { ...rule, workdays: ['2026-10-10'] };
        expect(periodAt(rule, new Date('2026-10-10T10:00:00+08:00'))).toBe('offpeak');
        expect(periodAt(workday, new Date('2026-10-10T10:00:00+08:00'))).toBe('peak');
        expect(periodAt(workday, new Date('2026-10-10T12:30:00+08:00'))).toBe('offpeak');
        expect(periodAt(workday, new Date('2026-10-11T10:00:00+08:00'))).toBe('offpeak');
    });

    it('lets a holiday win over a workday listed for the same date', () => {
        const both = { ...rule, holidays: ['2026-10-10'], workdays: ['2026-10-10'] };
        expect(periodAt(both, new Date('2026-10-10T10:00:00+08:00'))).toBe('offpeak');
    });

    it('rejects malformed rules and dates', () => {
        const at = new Date('2026-10-26T10:00:00+08:00');
        const broken = (from: string, to: string): PeriodRule => ({ ...rule, peak: [{ days: [1], from, to }] });
        expect(() => periodAt(broken('9:00', '12:00'), at)).toThrow(RangeError);
        expect(() => periodAt(broken('09:00', '24:30'), at)).toThrow(RangeError);
        expect(() => periodAt(broken('22:00', '02:00'), at)).toThrow(/crosses midnight/);
        expect(() => periodAt(rule, new Date(Number.NaN))).toThrow(RangeError);
    });
});

describe('nextPeriodChange', () => {
    const next = (from: string, current: PeriodRule = rule) => nextPeriodChange(current, new Date(from))?.toISOString();
    const iso = (value: string) => new Date(value).toISOString();

    it.each([
        ['2026-10-26T08:00:00+08:00', '2026-10-26T09:00:00+08:00'],
        ['2026-10-26T09:00:00+08:00', '2026-10-26T12:00:00+08:00'],
        ['2026-10-26T12:30:00+08:00', '2026-10-26T14:00:00+08:00'],
        ['2026-10-26T15:00:00+08:00', '2026-10-26T18:00:00+08:00'],
        ['2026-10-30T19:00:00+08:00', '2026-11-02T09:00:00+08:00'],
        ['2026-10-31T10:00:00+08:00', '2026-11-02T09:00:00+08:00'],
    ])('from %s the period next flips at %s', (from, expected) => {
        expect(next(from)).toBe(iso(expected));
    });

    it('skips holidays and stops on adjusted workdays', () => {
        expect(next('2026-10-30T19:00:00+08:00', { ...rule, holidays: ['2026-11-02'] })).toBe(
            iso('2026-11-03T09:00:00+08:00'),
        );
        expect(next('2026-10-30T19:00:00+08:00', { ...rule, workdays: ['2026-10-31'] })).toBe(
            iso('2026-10-31T09:00:00+08:00'),
        );
    });

    it('finds a flip at midnight when a window ends at 24:00', () => {
        const evening: PeriodRule = {
            timezone: 'Asia/Shanghai',
            peak: [{ days: ALL_DAYS, from: '20:00', to: '24:00' }],
            offPeakMultiplier: 0.5,
        };
        expect(periodAt(evening, new Date('2026-10-26T23:59:00+08:00'))).toBe('peak');
        expect(next('2026-10-26T21:00:00+08:00', evening)).toBe(iso('2026-10-27T00:00:00+08:00'));
    });

    it('converts local boundaries correctly across a DST change', () => {
        const office: PeriodRule = {
            timezone: 'America/New_York',
            peak: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }],
            offPeakMultiplier: 0.5,
        };
        // Friday 18:00 EDT; daylight saving ends on Sunday 2026-11-01, so Monday 09:00 is EST.
        expect(next('2026-10-30T18:00:00-04:00', office)).toBe('2026-11-02T14:00:00.000Z');
        // Clocks go back from 02:00 EDT to 01:00 EST at 06:00 UTC, so 03:00 that night is 08:00 UTC.
        const night: PeriodRule = { ...office, peak: [{ days: [7], from: '03:00', to: '05:00' }] };
        expect(next('2026-11-01T00:30:00-04:00', night)).toBe('2026-11-01T08:00:00.000Z');
        expect(next('2026-11-01T03:30:00-05:00', night)).toBe('2026-11-01T10:00:00.000Z');
    });

    it('returns undefined when the period never flips', () => {
        expect(next('2026-10-26T10:00:00+08:00', { ...rule, peak: [] })).toBeUndefined();
        const always: PeriodRule = { ...rule, peak: [{ days: ALL_DAYS, from: '00:00', to: '24:00' }] };
        expect(next('2026-10-26T10:00:00+08:00', always)).toBeUndefined();
    });
});

describe('offPeakStart', () => {
    const start = (from: string, rules: readonly PeriodRule[] = [rule]) =>
        offPeakStart(rules, new Date(from))?.toISOString();
    const iso = (value: string) => new Date(value).toISOString();

    it.each([
        // Monday morning peak: wait for the lunch break.
        ['2026-10-26T10:00:00+08:00', '2026-10-26T12:00:00+08:00'],
        // Already off-peak: start right away.
        ['2026-10-26T12:30:00+08:00', '2026-10-26T12:30:00+08:00'],
        ['2026-10-26T08:59:00+08:00', '2026-10-26T08:59:00+08:00'],
        // Afternoon peak ends at 18:00; Friday too.
        ['2026-10-26T14:00:00+08:00', '2026-10-26T18:00:00+08:00'],
        ['2026-10-30T17:59:00+08:00', '2026-10-30T18:00:00+08:00'],
        // Weekends are off-peak all day.
        ['2026-10-31T10:00:00+08:00', '2026-10-31T10:00:00+08:00'],
    ])('a deepseek run asked for at %s starts at %s', (from, expected) => {
        expect(start(from)).toBe(iso(expected));
    });

    it('starts at once without rules, and for vendors without peak hours', () => {
        expect(start('2026-10-26T10:00:00+08:00', [])).toBe(iso('2026-10-26T10:00:00+08:00'));
        expect(start('2026-10-26T10:00:00+08:00', [{ ...rule, peak: [] }])).toBe(iso('2026-10-26T10:00:00+08:00'));
    });

    it('waits until every rule is off-peak at the same time', () => {
        // A second vendor whose peak runs 11:00–13:00 Beijing time, so the common window opens at 13:00.
        const late: PeriodRule = {
            timezone: 'Asia/Shanghai',
            peak: [{ days: ALL_DAYS, from: '11:00', to: '13:00' }],
            offPeakMultiplier: 0.5,
        };
        expect(start('2026-10-26T10:00:00+08:00', [rule, late])).toBe(iso('2026-10-26T13:00:00+08:00'));
        expect(start('2026-10-26T10:00:00+08:00', [late, rule])).toBe(iso('2026-10-26T13:00:00+08:00'));
        // A New York office-hours rule (09:00–17:00 EDT = 21:00–05:00 Beijing) pushes the evening start to 05:00.
        const office: PeriodRule = {
            timezone: 'America/New_York',
            peak: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }],
            offPeakMultiplier: 0.5,
        };
        expect(start('2026-10-27T20:30:00+08:00', [rule, office])).toBe(iso('2026-10-27T20:30:00+08:00'));
        expect(start('2026-10-27T21:30:00+08:00', [rule, office])).toBe(iso('2026-10-28T05:00:00+08:00'));
        // 05:00 on Wednesday is off-peak for both: deepseek's day only starts at 09:00.
        expect(periodAt(rule, new Date('2026-10-28T05:00:00+08:00'))).toBe('offpeak');
    });

    it('gives up when no common off-peak time comes within eight days', () => {
        const always: PeriodRule = { ...rule, peak: [{ days: ALL_DAYS, from: '00:00', to: '24:00' }] };
        expect(start('2026-10-26T10:00:00+08:00', [always])).toBeUndefined();
        // Two vendors whose off-peak hours never overlap.
        const morning: PeriodRule = { ...rule, peak: [{ days: ALL_DAYS, from: '00:00', to: '12:00' }] };
        const evening: PeriodRule = { ...rule, peak: [{ days: ALL_DAYS, from: '12:00', to: '24:00' }] };
        expect(start('2026-10-26T10:00:00+08:00', [morning, evening])).toBeUndefined();
    });

    it('rejects an invalid date', () => {
        expect(() => offPeakStart([rule], new Date(Number.NaN))).toThrow(RangeError);
    });
});
