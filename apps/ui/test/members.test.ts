import type { Member } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import { avatarHue, choiceOf, cronOf, initialOf, memberOf, sortMembers, workKind } from '../src/members.ts';

function member(id: string, source: Member['source'], name = id): Member {
    return {
        id,
        name,
        role: 'scout',
        tier: 'fast',
        mode: 'plan',
        prompt: '',
        source,
        customized: false,
        memory: { chars: 0 },
        routines: [],
    };
}

describe('members', () => {
    it('turns the routine form into cron and back', () => {
        expect(cronOf({ preset: 'daily', time: '09:30', cron: '' })).toBe('30 9 * * *');
        expect(cronOf({ preset: 'weekdays', time: '18:05', cron: '' })).toBe('5 18 * * 1-5');
        expect(cronOf({ preset: 'weekly', time: '08:00', cron: '' })).toBe('0 8 * * 1');
        expect(cronOf({ preset: 'hourly', time: '08:00', cron: '' })).toBe('0 * * * *');
        expect(cronOf({ preset: 'custom', time: '', cron: ' */15 * * * * ' })).toBe('*/15 * * * *');
        expect(choiceOf('30 9 * * *')).toEqual({ preset: 'daily', time: '09:30', cron: '30 9 * * *' });
        expect(choiceOf('5 18 * * 1-5').preset).toBe('weekdays');
        expect(choiceOf('0 8 * * 1')).toMatchObject({ preset: 'weekly', time: '08:00' });
        expect(choiceOf('@hourly').preset).toBe('hourly');
        expect(choiceOf('*/15 * * * *')).toMatchObject({ preset: 'custom', cron: '*/15 * * * *' });
        expect(choiceOf('0 25 * * *').preset).toBe('custom');
    });

    it('gives each member a stable look', () => {
        expect(avatarHue('scout')).toBe(avatarHue('scout'));
        expect(avatarHue('scout')).toBeGreaterThanOrEqual(0);
        expect(avatarHue('scout')).toBeLessThan(360);
        expect(initialOf('侦察')).toBe('侦');
        expect(initialOf(' reviewer')).toBe('R');
        expect(initialOf('')).toBe('?');
    });

    it('tells a member’s own threads from the threads of runs', () => {
        const members = [member('scout', 'builtin'), member('daily-report', 'user')];
        expect(memberOf({ agentId: 'scout' }, members)?.id).toBe('scout');
        expect(memberOf({ agentId: 'scout', workflowRunId: 'r1' }, members)).toBeUndefined();
        expect(memberOf({ agentId: 'gone' }, members)).toBeUndefined();
        expect(workKind({ title: '侦察：查一下', workflowRunId: 'r1' })).toBe('workflow');
        expect(workKind({ title: 'x', teamRunId: 't1' })).toBe('team');
        expect(workKind({ title: '例行：早报' })).toBe('routine');
        expect(workKind({ title: 'Routine: morning report' })).toBe('routine');
        expect(workKind({ title: '侦察：查一下' })).toBe('chat');
    });

    it('lists built-in members first, then the user’s and the project’s by name', () => {
        const sorted = sortMembers([
            member('z', 'project'),
            member('b', 'user', 'Beta'),
            member('scout', 'builtin'),
            member('a', 'user', 'Alpha'),
            member('coder', 'builtin'),
        ]);
        expect(sorted.map((item) => item.id)).toEqual(['scout', 'coder', 'a', 'b', 'z']);
    });
});
