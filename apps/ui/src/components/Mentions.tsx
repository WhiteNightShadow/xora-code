import type { Member } from '@xora/protocol';
import { type KeyboardEvent, useState } from 'react';
import { memberJob } from '../members.ts';
import { useApp, useStrings } from '../store.ts';
import type { Strings } from '../strings.ts';

/**
 * `@` mentions of the team's members (06 §19): a message that names a member by `@name` is handed to it. Every
 * member but the supervisors, who lead runs and are not handed messages.
 */
export interface MemberMention {
    readonly value: string;
    readonly hint?: string;
}

export function memberMentions(members: readonly Member[], query: string, s: Strings, limit = 8): MemberMention[] {
    const lower = query.toLowerCase();
    return members
        .filter(
            (member) =>
                member.role !== 'supervisor' &&
                (member.name.toLowerCase().includes(lower) || member.id.toLowerCase().includes(lower)),
        )
        .slice(0, limit)
        .map((member) => {
            const job = memberJob(member, s);
            return { value: member.name, ...(job ? { hint: job } : {}) };
        });
}

interface MentionState {
    readonly query: string;
    readonly start: number;
    readonly items: readonly MemberMention[];
    readonly index: number;
}

/** `@` in a plain message box: the members to hand the message to, picked with the arrows and Enter or Tab. */
export function useMemberMention(text: string, setText: (text: string) => void) {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const [state, setState] = useState<MentionState>();
    const update = (value: string, caret: number) => {
        const match = /(^|[^A-Za-z0-9_@])@([^\s@]*)$/.exec(value.slice(0, caret));
        const query = match?.[2] ?? '';
        const items = match ? memberMentions(members, query, s) : [];
        setState(items.length > 0 ? { query, start: caret - query.length - 1, items, index: 0 } : undefined);
    };
    const pick = (item: MemberMention) => {
        if (!state) return;
        setText(`${text.slice(0, state.start)}@${item.value} ${text.slice(state.start + state.query.length + 1)}`);
        setState(undefined);
    };
    /** True when the key was the list's. */
    const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!state || event.nativeEvent.isComposing) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setState({ ...state, index: (state.index + step + state.items.length) % state.items.length });
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            const item = state.items[state.index];
            if (item) pick(item);
            return true;
        }
        if (event.key === 'Escape') {
            setState(undefined);
            return true;
        }
        return false;
    };
    return { state, update, pick, keyDown };
}

export function MemberMentionList({ mention }: { mention: ReturnType<typeof useMemberMention> }) {
    const s = useStrings();
    const state = mention.state;
    if (!state) return null;
    return (
        <div className="mention mention--members" role="listbox" aria-label={s.thread.mentionMembers}>
            {state.items.map((item, index) => (
                <button
                    key={item.value}
                    type="button"
                    role="option"
                    aria-selected={index === state.index}
                    className={index === state.index ? 'is-active' : ''}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        mention.pick(item);
                    }}
                >
                    @{item.value}
                    {item.hint && <span className="mention__hint">{item.hint}</span>}
                </button>
            ))}
        </div>
    );
}
