import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { type Member, RpcError, RpcErrorCode, type ThreadMeta } from '@xora/protocol';
import type { HostToolResult } from '../engines/manager.ts';
import { XORA_ENGINE } from '../engines/registry.ts';
import { type Logger, redact } from '../log.ts';
import { readGroups, readGroupsSync } from '../org-groups.ts';
import type { ProjectService } from '../projects.ts';
import { shorten } from '../team-agents.ts';
import { textOf } from '../text.ts';
import type { HostToolProvider, SharedToolCall, SharedTools } from '../turns.ts';
import { folderName, MemoryPaths, projectStem, readNames, Serial, writeAtomic } from './files.ts';
import {
    NOTE_CHARS,
    noteDate,
    noteText,
    oneLine,
    placeNote,
    queryTerms,
    RECALL_CONVERSATIONS,
    RECALL_RESULTS,
    RECALL_TOOL,
    REMEMBER_TOOL,
    recentNotes,
    today,
} from './notes.ts';
import { MEMORY_TEXT } from './text.ts';

/**
 * Long-term memory (06 §19, §21, 20 §4.6): notes the agents keep with `remember` and look up with `recall`, in
 * Markdown files the user can read and edit. Every thread of the Xora engine has memory: a member's threads its own
 * (`provide`), any other thread outside team and workflow runs — a conversation, the chief's, a subagent of one —
 * the user's preferences and the project's notes, as shared tools. A thread takes its memory once, when it starts,
 * so its system prompt and with it the provider's cache stay as they are; what is written later is a recall away.
 */

type Layer = NonNullable<HostToolProvider['layers']>[number];
type Tool = HostToolProvider['tools'][number];

/** What a prompt carries of each part, in characters; the most recent notes are kept. */
export const MEMORY_PROMPT_PARTS = { user: 1_500, member: 2_000, project: 3_500, team: 2_500, root: 1_500 } as const;
/** Snapshots of conversations kept at most; an older conversation takes its memory afresh. */
const SNAPSHOTS = 500;

/** Where a note goes: the user's preferences, a member's general notes, its notes in the project, or shared ones. */
export type MemoryScope = 'user' | 'member' | 'project' | 'team';

/** Whose memory: a member working (in a project, perhaps for an organization), or the user's own thread. */
export type MemorySubject =
    | {
          readonly kind: 'member';
          readonly memberId: string;
          readonly name: string;
          readonly projectId: string;
          /** The organization its notes for others go to; absent: everyone's. */
          readonly groupId?: string | undefined;
      }
    | {
          readonly kind: 'user';
          /** None for the chief's conversations, which belong to no project. */
          readonly projectId?: string | undefined;
          readonly threadId?: string | undefined;
      };

export interface MemoryDeps {
    readonly membersDir: string;
    readonly orgsDir: string;
    readonly projects: Pick<ProjectService, 'get' | 'list' | 'nameOf'>;
    readonly log: Logger;
    readonly now?: () => number;
    /** The members' names by id, to say whose notes recall found. */
    readonly memberNames?: (projectId: string | undefined) => Promise<ReadonlyMap<string, string>>;
    /** Earlier conversations that mention a query, from the threads' full-text index, for recall. */
    readonly conversations?: (
        query: string,
    ) => ReadonlyArray<{ readonly threadId: string; readonly title: string; readonly snippet: string }>;
    /** The threads, to know whose a shared tool call is. */
    readonly thread?: (threadId: string) => ThreadMeta | undefined;
    /** A member's notes changed: its panel shows them again. */
    readonly onChanged?: (memberId: string) => void;
}

/** Threads with memory of the user's own: those of the Xora engine outside team and workflow runs. */
export function sharesMemory(thread: ThreadMeta): boolean {
    return thread.engine === XORA_ENGINE.id && !thread.teamRunId && !thread.workflowRunId;
}

function subjectOf(thread: ThreadMeta): Extract<MemorySubject, { kind: 'user' }> {
    return { kind: 'user', projectId: thread.role === 'chief' ? undefined : thread.projectId, threadId: thread.id };
}

function argsOf(input: unknown): Record<string, unknown> {
    return (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
}

export class MemoryService implements SharedTools {
    readonly names = [REMEMBER_TOOL, RECALL_TOOL];
    readonly #deps: MemoryDeps;
    readonly #paths: MemoryPaths;
    readonly #serial = new Serial();
    /** Members whose memory file was looked at for notes to move into project files (06 §21). */
    readonly #migrated = new Set<string>();
    /** The memory each conversation began with. */
    readonly #snapshots = new Map<string, Layer>();

    constructor(deps: MemoryDeps) {
        this.#deps = deps;
        this.#paths = new MemoryPaths(deps.membersDir, deps.orgsDir);
    }

    #now(): number {
        return this.#deps.now?.() ?? Date.now();
    }

    // Shared tools: the threads of the user's own -------------------------------------------------------------

    tools(thread: ThreadMeta): HostToolProvider['tools'] {
        return sharesMemory(thread) ? this.toolsFor(subjectOf(thread)) : [];
    }

    instructions(): undefined {
        return undefined;
    }

    /** Its memory as it was when the conversation began; none when its run gives it a memory of its own. */
    layers(thread: ThreadMeta, provider: HostToolProvider | undefined): Layer[] {
        if (!sharesMemory(thread) || provider?.tools.some((tool) => tool.name === REMEMBER_TOOL)) return [];
        let layer = this.#snapshots.get(thread.id);
        if (!layer) {
            layer = this.layerFor(subjectOf(thread));
            this.#snapshots.set(thread.id, layer);
            if (this.#snapshots.size > SNAPSHOTS) {
                const oldest = this.#snapshots.keys().next().value;
                if (oldest !== undefined) this.#snapshots.delete(oldest);
            }
        }
        return [layer];
    }

    async handle(name: string, input: unknown, call: SharedToolCall): Promise<HostToolResult> {
        const thread = this.#deps.thread?.(call.threadId);
        if (!thread || !sharesMemory(thread)) {
            return { content: textOf(MEMORY_TEXT).unavailable(name), isError: true };
        }
        return this.handleFor(subjectOf(thread), name, input);
    }

    // Any subject ---------------------------------------------------------------------------------------------

    /** `remember` and `recall`, as the subject may use them. */
    toolsFor(subject: MemorySubject): Tool[] {
        const text = textOf(MEMORY_TEXT);
        const scopes =
            subject.kind === 'member'
                ? { enum: ['project', 'member', 'team', 'user'], description: text.rememberScope }
                : subject.projectId
                  ? { enum: ['project', 'user'], description: text.rememberScopeUser }
                  : { enum: ['user'], description: text.rememberScopeUserOnly };
        return [
            {
                name: REMEMBER_TOOL,
                description: text.rememberTool,
                parameters: {
                    type: 'object',
                    properties: {
                        note: { type: 'string', description: text.rememberNote },
                        replaces: { type: 'string', description: text.rememberReplaces },
                        scope: { type: 'string', ...scopes },
                    },
                    required: ['note'],
                    additionalProperties: false,
                },
                kind: 'other',
            },
            {
                name: RECALL_TOOL,
                description: text.recallTool,
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: text.recallQuery },
                        member: { type: 'string', description: text.recallMember },
                    },
                    required: ['query'],
                    additionalProperties: false,
                },
                kind: 'read',
            },
        ];
    }

    handleFor(subject: MemorySubject, name: string, input: unknown): Promise<HostToolResult> {
        if (name === REMEMBER_TOOL) return this.#remember(subject, input);
        if (name === RECALL_TOOL) return this.#recall(subject, input);
        return Promise.resolve({ content: textOf(MEMORY_TEXT).unavailable(name), isError: true });
    }

    /** The memory a subject's prompt carries, as it is now. */
    layerFor(subject: MemorySubject): Layer {
        const text = textOf(MEMORY_TEXT);
        const user = this.#part(this.#paths.user(), MEMORY_PROMPT_PARTS.user);
        if (subject.kind === 'user') {
            return {
                id: 'memory',
                title: text.userMemoryTitle,
                text: text.userMemory({
                    user,
                    ...(subject.projectId
                        ? {
                              project: {
                                  name: this.#projectName(subject.projectId),
                                  notes: this.#part(this.#paths.root(subject.projectId), MEMORY_PROMPT_PARTS.project),
                              },
                          }
                        : {}),
                }),
            };
        }
        const { memberId, name, projectId, groupId } = subject;
        void this.#migrate(memberId);
        const groups = readGroupsSync(this.#deps.orgsDir) ?? [];
        const organization = groups.find((group) => group.id === groupId)?.name;
        let others: string[] = [];
        try {
            const dir = this.#paths.memberProjectsDir(memberId);
            let names: Record<string, string> = {};
            try {
                names = JSON.parse(readFileSync(path.join(dir, 'names.json'), 'utf8')) as Record<string, string>;
            } catch {
                // No names kept.
            }
            others = readdirSync(dir)
                .filter((entry) => entry.endsWith('.md') && entry !== `${projectStem(projectId)}.md`)
                .map((entry) => this.#label(names, entry.slice(0, -3)));
        } catch {
            // No project notes.
        }
        return {
            id: 'member_memory',
            title: text.memoryTitle(name),
            text: text.memory({
                name,
                project: this.#projectName(projectId),
                user,
                member: this.#part(this.#paths.member(memberId), MEMORY_PROMPT_PARTS.member),
                own: this.#part(this.#paths.memberProject(memberId, projectId), MEMORY_PROMPT_PARTS.project),
                team: this.#part(this.#paths.org(groupId, projectId), MEMORY_PROMPT_PARTS.team),
                ...(groupId === undefined || organization === undefined
                    ? {}
                    : { org: organization, root: this.#part(this.#paths.root(projectId), MEMORY_PROMPT_PARTS.root) }),
                others,
            }),
        };
    }

    #part(file: string, limit: number): string {
        const text = textOf(MEMORY_TEXT);
        let saved = '';
        try {
            saved = readFileSync(file, 'utf8');
        } catch {
            // No notes yet.
        }
        const recent = recentNotes(saved, limit);
        return recent.text ? `${recent.omitted ? `${text.olderOmitted}\n` : ''}${recent.text}` : text.noNotes;
    }

    #projectName(projectId: string): string | undefined {
        try {
            return this.#deps.projects.nameOf(projectId);
        } catch {
            return undefined;
        }
    }

    #label(names: Record<string, string>, stem: string): string {
        return names[stem] ?? this.#projectName(stem) ?? stem;
    }

    /** Keeps the display name of a project's memory file, so it reads well after the project is gone. */
    async #nameFile(dir: string, stem: string, name: string): Promise<void> {
        await this.#serial.run(`names:${dir}`, async () => {
            const names = await readNames(dir);
            if (names[stem] === name) return;
            await writeAtomic(path.join(dir, 'names.json'), `${JSON.stringify({ ...names, [stem]: name }, null, 2)}\n`);
        });
    }

    /** The file a note of this scope goes to; `undefined` when the subject has no such notes. */
    #scopeFile(subject: MemorySubject, scope: MemoryScope): string | undefined {
        if (scope === 'user') return this.#paths.user();
        if (subject.kind === 'user') {
            return scope === 'project' && subject.projectId ? this.#paths.root(subject.projectId) : undefined;
        }
        if (scope === 'member') return this.#paths.member(subject.memberId);
        return scope === 'team'
            ? this.#paths.org(subject.groupId, subject.projectId)
            : this.#paths.memberProject(subject.memberId, subject.projectId);
    }

    /** The `remember` tool: a note appended or put in place of an old one; the oldest go past the size limit. */
    async #remember(subject: MemorySubject, input: unknown): Promise<HostToolResult> {
        const text = textOf(MEMORY_TEXT);
        const args = argsOf(input);
        const note = typeof args.note === 'string' ? oneLine(args.note) : '';
        if (!note) return { content: text.noteMissing, isError: true };
        if (note.length > NOTE_CHARS) return { content: text.noteTooLong(note.length), isError: true };
        if (redact(note) !== note) return { content: text.noteSecret, isError: true };
        const replaces = typeof args.replaces === 'string' ? oneLine(args.replaces) : '';
        // A thread without a project notes the user's preferences unless told otherwise.
        const fallback = subject.kind === 'user' && !subject.projectId ? 'user' : 'project';
        const given =
            args.scope === 'member' || args.scope === 'team' || args.scope === 'user' || args.scope === 'project'
                ? args.scope
                : fallback;
        // The user's own threads write no member's notes; one without a project writes the user's preferences.
        const scope: MemoryScope =
            subject.kind === 'user' && (given === 'member' || given === 'team') ? 'project' : given;
        const file = this.#scopeFile(subject, scope);
        if (!file) return { content: text.noProjectScope, isError: true };
        const projectId = subject.projectId;
        let tag = `[${today(this.#now())}]`;
        if (projectId && scope !== 'user' && scope !== 'member') {
            const label = this.#projectName(projectId) ?? projectId;
            // A general note holds in every project: its tag is the date alone.
            tag = `[${label} ${today(this.#now())}]`;
            await this.#nameFile(path.dirname(file), projectStem(projectId), label);
        }
        if (subject.kind === 'member') await this.#migrate(subject.memberId);
        const result = await this.#serial.run(`memory:${file}`, async (): Promise<HostToolResult> => {
            const placed = placeNote(await readFile(file, 'utf8').catch(() => ''), `- ${tag} ${note}`, note, replaces);
            if (placed.outcome === 'noMatch') return { content: text.noMatch(replaces), isError: true };
            if (placed.outcome === 'already') return { content: text.already };
            await writeAtomic(file, `${placed.lines.join('\n')}\n`);
            const message = placed.outcome === 'replaced' ? text.replaced : text.noted;
            return { content: placed.dropped > 0 ? `${message} ${text.dropped(placed.dropped)}` : message };
        });
        if (!result.isError) {
            const who = subject.kind === 'member' ? `member ${subject.memberId}` : 'a conversation';
            this.#deps.log.info(`${who} remembered a ${scope} note${projectId ? ` in ${projectId}` : ''}`);
            if (subject.kind === 'member') this.#deps.onChanged?.(subject.memberId);
        }
        return result;
    }

    /**
     * `recall` (06 §21): notes about a query — the user's, every member's general and project notes, everyone's and
     * each organization's — ranked by the words they share with it, the subject's own and this project's first, then
     * the newest; then earlier conversations that mention it.
     */
    async #recall(subject: MemorySubject, input: unknown): Promise<HostToolResult> {
        const text = textOf(MEMORY_TEXT);
        const args = argsOf(input);
        const query = typeof args.query === 'string' ? oneLine(args.query) : '';
        if (!query) return { content: text.recallQuery, isError: true };
        const terms = queryTerms(query);
        const projectId = subject.projectId;
        const self = subject.kind === 'member' ? subject.memberId : undefined;
        const groupId = subject.kind === 'member' ? subject.groupId : undefined;
        const wanted = typeof args.member === 'string' ? args.member.trim().toLowerCase() : '';
        const names = (await this.#deps.memberNames?.(projectId).catch(() => undefined)) ?? new Map<string, string>();
        const who = wanted
            ? [...names].find(([id, name]) => id.toLowerCase() === wanted || name.toLowerCase() === wanted)?.[0]
            : undefined;
        const here = (stem: string) => (projectId !== undefined && stem === projectStem(projectId) ? 1 : 0);
        const sources: Array<{ file: string; who: string; project: string | undefined; boost: number }> = [];
        if (who === undefined) {
            sources.push({
                file: this.#paths.user(),
                who: text.userLabel,
                project: undefined,
                boost: subject.kind === 'user' ? 2 : 1,
            });
        }
        const membersDir = this.#paths.membersDir;
        for (const folder of await readdir(membersDir).catch(() => [] as string[])) {
            if (who !== undefined && folder !== folderName(who)) continue;
            const mine = self !== undefined && folder === folderName(self);
            const label = names.get(folder) ?? folder;
            sources.push({
                file: path.join(membersDir, folder, 'memory.md'),
                who: label,
                project: undefined,
                boost: mine ? 2 : 0,
            });
            const dir = path.join(membersDir, folder, 'projects');
            const labels = await readNames(dir);
            for (const file of (await readdir(dir).catch(() => [] as string[])).filter((entry) =>
                entry.endsWith('.md'),
            )) {
                const stem = file.slice(0, -3);
                sources.push({
                    file: path.join(dir, file),
                    who: label,
                    project: this.#label(labels, stem),
                    boost: (mine ? 2 : 0) + here(stem),
                });
            }
        }
        if (who === undefined) {
            // Everyone's notes and each organization's, the one it works in first.
            const shared = [
                { dir: this.#paths.rootDir(), who: text.teamLabel, boost: 1 },
                ...((await readGroups(this.#deps.orgsDir)) ?? []).map((group) => ({
                    dir: this.#paths.groupDir(group.id),
                    who: group.name,
                    boost: group.id === groupId ? 1 : 0,
                })),
            ];
            for (const place of shared) {
                const labels = await readNames(place.dir);
                for (const file of (await readdir(place.dir).catch(() => [] as string[])).filter((entry) =>
                    entry.endsWith('.md'),
                )) {
                    const stem = file.slice(0, -3);
                    sources.push({
                        file: path.join(place.dir, file),
                        who: place.who,
                        project: this.#label(labels, stem),
                        boost: place.boost + here(stem),
                    });
                }
            }
        }
        const found: Array<{ line: string; score: number; date: string }> = [];
        for (const source of sources) {
            const saved = await readFile(source.file, 'utf8').catch(() => '');
            for (const line of saved.split('\n')) {
                const words = noteText(line).toLowerCase();
                if (!words) continue;
                const hits = terms.filter((term) => words.includes(term)).length;
                if (hits === 0) continue;
                const where = source.project ? `${source.who} · ${source.project}` : source.who;
                found.push({
                    line: `- (${where}) ${line.replace(/^\s*[-*]\s*/, '')}`,
                    score: hits * 3 + source.boost,
                    date: noteDate(line),
                });
            }
        }
        const conversations = who === undefined ? this.#conversations(subject, query, terms) : [];
        if (found.length === 0 && conversations.length === 0) return { content: text.recallNone(query) };
        found.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
        const top = found.slice(0, RECALL_RESULTS);
        const lines =
            top.length > 0 ? [text.recallHeader(top.length), ...top.map((item) => shorten(item.line, 400))] : [];
        if (conversations.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push(text.recallConversations, ...conversations);
        }
        return { content: lines.join('\n') };
    }

    /** Earlier conversations that mention the query, the subject's own excluded: the whole query, else its words. */
    #conversations(subject: MemorySubject, query: string, terms: readonly string[]): string[] {
        const search = this.#deps.conversations;
        if (!search) return [];
        const current = subject.kind === 'user' ? subject.threadId : undefined;
        const seen = new Set<string>(current ? [current] : []);
        const out: string[] = [];
        const words = [query, ...terms.filter((term) => term !== query.toLowerCase() && [...term].length >= 3)];
        for (const word of words) {
            for (const hit of search(word)) {
                if (seen.has(hit.threadId)) continue;
                seen.add(hit.threadId);
                out.push(
                    `- (${textOf(MEMORY_TEXT).conversation(shorten(hit.title, 60))}) ${shorten(hit.snippet, 300)}`,
                );
                if (out.length >= RECALL_CONVERSATIONS) return out;
            }
            if (out.length > 0) break;
        }
        return out;
    }

    // A member's memory, for its panel (06 §21) ----------------------------------------------------------------

    /** The file of one part of a member's memory; `groupId`: the organization its `team` notes go to. */
    #memberFile(memberId: string, scope: MemoryScope, projectId: string | undefined, groupId?: string): string {
        if (scope === 'user') return this.#paths.user();
        if (scope === 'member') return this.#paths.member(memberId);
        if (!projectId) {
            throw new RpcError(RpcErrorCode.InvalidParams, textOf(MEMORY_TEXT).projectNeeded);
        }
        return scope === 'team' ? this.#paths.org(groupId, projectId) : this.#paths.memberProject(memberId, projectId);
    }

    /**
     * One part of a member's memory, with the projects it has notes in. Notes of the earlier single file that name
     * a project the app knows move to that project first.
     */
    async read(
        memberId: string,
        scope: MemoryScope,
        projectId: string | undefined,
        groupId: string | undefined,
    ): Promise<{
        text: string;
        updatedAt?: number;
        projects: Array<{ projectId: string; name: string; chars: number }>;
    }> {
        await this.#migrate(memberId);
        const file = this.#memberFile(memberId, scope, projectId, groupId);
        const projects = await this.#memberProjects(memberId);
        try {
            const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
            return { text, updatedAt: Math.round(info.mtimeMs), projects };
        } catch {
            return { text: '', projects };
        }
    }

    /** The user edits or clears one part of a member's memory. */
    async write(
        memberId: string,
        text: string,
        scope: MemoryScope,
        projectId: string | undefined,
        groupId: string | undefined,
    ): Promise<void> {
        await this.#migrate(memberId);
        const file = this.#memberFile(memberId, scope, projectId, groupId);
        const tidy = text.replace(/\r\n?/g, '\n').trim();
        await this.#serial.run(`memory:${file}`, () =>
            tidy ? writeAtomic(file, `${tidy}\n`) : rm(file, { force: true }),
        );
        this.#deps.onChanged?.(memberId);
    }

    /** The projects a member has notes in, by size. */
    async #memberProjects(memberId: string): Promise<Array<{ projectId: string; name: string; chars: number }>> {
        const dir = this.#paths.memberProjectsDir(memberId);
        const files = await readdir(dir).catch(() => [] as string[]);
        const names = await readNames(dir);
        const out: Array<{ projectId: string; name: string; chars: number }> = [];
        for (const file of files.filter((entry) => entry.endsWith('.md'))) {
            const projectId = file.slice(0, -3);
            const text = await readFile(path.join(dir, file), 'utf8').catch(() => '');
            if (text.trim()) {
                out.push({ projectId, name: this.#label(names, projectId), chars: text.trim().length });
            }
        }
        return out.sort((a, b) => b.chars - a.chars);
    }

    async stats(memberId: string): Promise<Member['memory']> {
        await this.#migrate(memberId);
        const general = this.#paths.member(memberId);
        const files = [
            general,
            ...(await this.#memberProjects(memberId)).map((project) =>
                this.#paths.memberProject(memberId, project.projectId),
            ),
        ];
        let chars = 0;
        let updatedAt: number | undefined;
        let projects = 0;
        for (const file of files) {
            try {
                const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
                const size = text.trim().length;
                if (size === 0) continue;
                chars += size;
                if (file !== general) projects += 1;
                updatedAt = Math.max(updatedAt ?? 0, Math.round(info.mtimeMs));
            } catch {
                // Not there yet.
            }
        }
        return {
            chars,
            ...(chars > 0 && updatedAt !== undefined ? { updatedAt } : {}),
            ...(projects > 0 ? { projects } : {}),
        };
    }

    /**
     * The single memory file of 06 §19 kept every note with a `[project date]` tag: the notes of a project the app
     * knows go to that project's file, once, and the rest stay as the general notes (06 §21).
     */
    #migrate(memberId: string): Promise<void> {
        if (this.#migrated.has(memberId)) {
            return Promise.resolve();
        }
        this.#migrated.add(memberId);
        const file = this.#paths.member(memberId);
        return this.#serial.run(`memory:${file}`, async () => {
            const saved = await readFile(file, 'utf8').catch(() => '');
            if (!saved.trim()) return;
            const projects = await this.#deps.projects.list().catch(() => []);
            const byName = new Map(projects.map((project) => [project.name, project.id]));
            const kept: string[] = [];
            // By project: an id the app knows, else the name the note carries (a project removed since).
            const moved = new Map<string, { name: string; lines: string[] }>();
            for (const line of saved.replace(/\r\n?/g, '\n').split('\n')) {
                if (!line.trim()) continue;
                const name = /^\s*[-*]\s*\[([^\]\n]*?)\s+\d{4}-\d{2}-\d{2}\]/.exec(line)?.[1]?.trim();
                if (!name) {
                    kept.push(line);
                    continue;
                }
                const key = byName.get(name) ?? `~${name}`;
                const entry = moved.get(key) ?? { name, lines: [] };
                entry.lines.push(line);
                moved.set(key, entry);
            }
            if (moved.size === 0) return;
            for (const [key, entry] of moved) {
                const target = this.#paths.memberProject(memberId, key);
                const before = await readFile(target, 'utf8').catch(() => '');
                const existing = before.split('\n').filter((line) => line.trim() !== '');
                const merged = [...existing, ...entry.lines.filter((line) => !existing.includes(line))];
                await writeAtomic(target, `${merged.join('\n')}\n`);
                await this.#nameFile(this.#paths.memberProjectsDir(memberId), projectStem(key), entry.name);
            }
            await (kept.length > 0 ? writeAtomic(file, `${kept.join('\n')}\n`) : rm(file, { force: true }));
            this.#deps.log.info(`member ${memberId}: moved notes of ${moved.size} project(s) out of memory.md`);
        });
    }
}
