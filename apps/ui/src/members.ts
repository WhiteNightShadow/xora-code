import type { Member, ThreadMeta } from '@xora/protocol';
import type { Strings } from './strings.ts';

/** The schedules the routine form offers; anything else is written as cron. */
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

export interface ScheduleChoice {
    readonly preset: SchedulePreset;
    /** `HH:MM` for the daily, weekday and weekly presets. */
    readonly time: string;
    /** The cron text of a custom schedule. */
    readonly cron: string;
}

/** The cron of a choice; a custom one as written. */
export function cronOf(choice: ScheduleChoice): string {
    const [hours = '9', minutes = '0'] = choice.time.split(':');
    const at = `${Number(minutes)} ${Number(hours)}`;
    switch (choice.preset) {
        case 'daily':
            return `${at} * * *`;
        case 'weekdays':
            return `${at} * * 1-5`;
        case 'weekly':
            return `${at} * * 1`;
        case 'hourly':
            return '0 * * * *';
        default:
            return choice.cron.trim();
    }
}

/** The form's choice for a cron: a preset when it is one, else custom. */
export function choiceOf(cron: string): ScheduleChoice {
    const text = cron.trim().replace(/\s+/g, ' ');
    if (text === '0 * * * *' || text === '@hourly') return { preset: 'hourly', time: '09:00', cron: text };
    if (text === '@daily' || text === '@midnight') return { preset: 'daily', time: '00:00', cron: text };
    const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/.exec(text);
    if (match) {
        const minutes = Number(match[1]);
        const hours = Number(match[2]);
        if (minutes < 60 && hours < 24) {
            const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            const preset = match[3] === '*' ? 'daily' : match[3] === '1-5' ? 'weekdays' : 'weekly';
            return { preset, time, cron: text };
        }
    }
    return { preset: 'custom', time: '09:00', cron: text };
}

/** A hue for a member's avatar, the same for the same id. */
export function avatarHue(id: string): number {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
    return hash;
}

/** The first character of a name for its avatar: a letter upper-cased, a Chinese character as it is. */
export function initialOf(name: string): string {
    const first = [...name.trim()][0] ?? '?';
    return first.toUpperCase();
}

export type WorkKind = 'chat' | 'workflow' | 'team' | 'routine';

/** What a member's thread was: a conversation, a workflow step, a team task or a routine run. */
export function workKind(thread: Pick<ThreadMeta, 'workflowRunId' | 'teamRunId' | 'title'>): WorkKind {
    if (thread.workflowRunId) return 'workflow';
    if (thread.teamRunId) return 'team';
    if (/^(例行：|Routine: )/.test(thread.title)) return 'routine';
    return 'chat';
}

/** The member a thread works as: its conversations and routine runs, not the threads of runs. */
export function memberOf(
    thread: Pick<ThreadMeta, 'agentId' | 'workflowRunId' | 'teamRunId'>,
    members: readonly Member[],
): Member | undefined {
    if (!thread.agentId || thread.workflowRunId || thread.teamRunId) return undefined;
    return members.find((member) => member.id === thread.agentId);
}

/** Built-in members first, then the user's, then the project's; by name within each. */
export function sortMembers(members: readonly Member[]): Member[] {
    const order = { builtin: 0, user: 1, project: 2 } as const;
    return [...members].sort(
        (a, b) => order[a.source] - order[b.source] || (a.source === 'builtin' ? 0 : a.name.localeCompare(b.name)),
    );
}

/** A built-in member's job in the UI language until the user writes another. */
export function memberJob(member: Member, s: Strings): string | undefined {
    if (member.source === 'builtin' && !member.customized) {
        return (s.members.builtinJobs as Record<string, string>)[member.id] ?? member.description;
    }
    return member.description;
}
