import {
    type Approval,
    type Attachment,
    type Connection,
    type LanguageSetting,
    type Member,
    type ModelOption,
    type OrgChart,
    type PresetSummary,
    type Project,
    resolveLanguage,
    type Settings,
    type SystemInfo,
    type TeamRun,
    type ThreadMeta,
    type UiLanguage,
    type UpdateStatus,
    type WorkflowRun,
} from '@xora/protocol';
import { create } from 'zustand';
import { errorMessage, host } from './host.ts';
import { STRINGS, type Strings } from './strings.ts';
import { applyDelta, applyEvent, applyLiveItem, type ThreadView, viewFromSnapshot } from './timeline.ts';

export type RightPanel =
    | 'changes'
    | 'worktree'
    | 'compare'
    | 'plan'
    | 'trajectory'
    | 'prompt'
    | 'terminal'
    | 'preview'
    | 'file';
/** The panels of a conversation with the chief: it hands work on in no project of its own (06 §23). */
export const CHIEF_PANELS: readonly RightPanel[] = ['plan', 'trajectory', 'prompt'];
export type SettingsSection =
    | 'general'
    | 'models'
    | 'prompts'
    | 'permissions'
    | 'extensions'
    | 'usage'
    | 'updates'
    | 'about';

export interface Toast {
    readonly id: number;
    readonly kind: 'info' | 'error' | 'success';
    readonly text: string;
}

interface AppState {
    connected: boolean;
    ready: boolean;
    info: SystemInfo | undefined;
    settings: Settings | undefined;
    projects: Project[];
    threads: Record<string, ThreadMeta>;
    views: Record<string, ThreadView>;
    approvals: Approval[];
    connections: Connection[];
    presets: PresetSummary[];
    models: ModelOption[];
    update: UpdateStatus | undefined;
    selectedProjectId: string | undefined;
    selectedThreadId: string | undefined;
    rightPanel: RightPanel | undefined;
    reviewTurnId: string | undefined;
    settingsOpen: SettingsSection | undefined;
    usageOpen: boolean;
    /** Project the new-thread dialog is open for. */
    newThreadFor: string | undefined;
    /** Threads shown side by side (03 §4), at most three. */
    split: string[];
    /** Attachments other panels hand to a thread's composer (preview screenshots, annotations). */
    composerInbox: Record<string, Attachment[]>;
    /** File shown in the file panel, relative to the thread's workspace. */
    filePath: string | undefined;
    teamRuns: Record<string, TeamRun>;
    /** Team run shown in the main area instead of a thread. */
    teamRunId: string | undefined;
    teamStartFor: string | undefined;
    /** The team board in the main area: the runs of one project, or of all (`ALL_PROJECTS`). */
    teamsFor: string | undefined;
    workflowRuns: Record<string, WorkflowRun>;
    /** Workflow run shown in the main area instead of a thread. */
    workflowRunId: string | undefined;
    /** The members of the selected project's organization (06 §19), for the members page, chips and mentions. */
    members: Member[];
    /** The members page is in the main area; `memberId` shows one member. */
    membersOpen: boolean;
    /** The talent market tab of the team's page (19 §15). */
    marketOpen: boolean;
    memberId: string | undefined;
    /** The member the "hand it work" dialog is open for. */
    dispatchTo: string | undefined;
    /** The chief assistant's home in the main area (06 §23); its conversations show as threads. */
    chiefOpen: boolean;
    /** The organization chart (06 §24): groups, their leads and members, deleted built-in members. */
    org: OrgChart | undefined;
    /** The group the "hand to a team" dialog starts with. */
    teamStartGroup: string | undefined;
    toasts: Toast[];
    /** Bumps when usage changes, so open usage views refetch. */
    usageVersion: number;
}

export const useApp = create<AppState>(() => ({
    connected: false,
    ready: false,
    info: undefined,
    settings: undefined,
    projects: [],
    threads: {},
    views: {},
    approvals: [],
    connections: [],
    presets: [],
    models: [],
    update: undefined,
    selectedProjectId: undefined,
    selectedThreadId: undefined,
    rightPanel: undefined,
    reviewTurnId: undefined,
    settingsOpen: undefined,
    usageOpen: false,
    newThreadFor: undefined,
    split: [],
    composerInbox: {},
    filePath: undefined,
    teamRuns: {},
    teamRunId: undefined,
    teamStartFor: undefined,
    teamsFor: undefined,
    workflowRuns: {},
    workflowRunId: undefined,
    members: [],
    membersOpen: false,
    marketOpen: false,
    memberId: undefined,
    dispatchTo: undefined,
    chiefOpen: false,
    org: undefined,
    teamStartGroup: undefined,
    toasts: [],
    usageVersion: 0,
}));

const set = useApp.setState;
const get = useApp.getState;

/** The language the UI shows: the setting, or the system's when it is `system` or not loaded yet. */
export function uiLanguage(setting: LanguageSetting | undefined): UiLanguage {
    return resolveLanguage(setting ?? 'system', navigator.languages);
}

export function useStrings(): Strings {
    return useApp((state) => STRINGS[uiLanguage(state.settings?.language)]);
}

export function strings(): Strings {
    return STRINGS[uiLanguage(get().settings?.language)];
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, kind, text }] }));
    setTimeout(
        () => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
        kind === 'error' ? 8000 : 4000,
    );
}

/** Runs a host call and turns failures into a toast. */
export async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
        return await work();
    } catch (error) {
        toast(errorMessage(error), 'error');
        return undefined;
    }
}

function touchView(threadId: string, view: ThreadView): void {
    set((state) => ({
        views: {
            ...state.views,
            [threadId]: { ...view, turns: view.turns.map((turn) => ({ ...turn, items: [...turn.items] })) },
        },
    }));
}

async function resync(threadId: string): Promise<void> {
    const snapshot = await host.call('thread.read', { threadId });
    touchView(threadId, viewFromSnapshot(snapshot));
    set((state) => ({ threads: { ...state.threads, [threadId]: snapshot.thread } }));
}

export async function refreshConnections(): Promise<void> {
    const [connections, models] = await Promise.all([
        host.call('provider.connections', {}),
        host.call('model.list', {}),
    ]);
    set({ connections, models });
}

async function loadAll(): Promise<void> {
    const [info, settings, projects, threads, approvals, presets, update, runs, workflowRuns] = await Promise.all([
        host.call('system.info', {}),
        host.call('settings.get', {}),
        host.call('project.list', {}),
        host.call('thread.list', { includeArchived: true }),
        host.call('approval.list', {}),
        host.call('provider.presets', {}),
        host.call('update.status', {}),
        host.call('team.list', {}),
        host.call('workflow.runs', {}),
    ]);
    await refreshConnections();
    void loadMembers(get().selectedProjectId ?? projects[0]?.id);
    const selectedThreadId = get().selectedThreadId;
    set((state) => ({
        info,
        settings,
        projects,
        threads: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
        approvals,
        presets,
        update,
        teamRuns: Object.fromEntries(runs.map((run) => [run.id, run])),
        workflowRuns: Object.fromEntries(workflowRuns.map((run) => [run.id, run])),
        ready: true,
        selectedProjectId: state.selectedProjectId ?? projects[0]?.id,
    }));
    // After a reconnect the new host peer has no subscriptions: restore every watched thread.
    for (const threadId of new Set([...watchers.keys(), ...(selectedThreadId ? [selectedThreadId] : [])])) {
        if (!watchers.has(threadId)) continue;
        await host.call('thread.subscribe', { threadId }).catch(() => undefined);
        await resync(threadId).catch(() => undefined);
    }
}

const watchers = new Map<string, number>();

/**
 * Subscribes to a thread's events while at least one view shows it (the main view, or a split pane) and loads
 * its snapshot. Returns the release function.
 */
export function watchThread(threadId: string): () => void {
    const count = (watchers.get(threadId) ?? 0) + 1;
    watchers.set(threadId, count);
    if (count === 1) {
        void attempt(async () => {
            await host.call('thread.subscribe', { threadId });
            await resync(threadId);
        });
    }
    return () => {
        const next = (watchers.get(threadId) ?? 1) - 1;
        if (next > 0) {
            watchers.set(threadId, next);
            return;
        }
        watchers.delete(threadId);
        void host.call('thread.unsubscribe', { threadId }).catch(() => undefined);
    };
}

function listen(): void {
    host.on('thread.meta', ({ thread }) => set((state) => ({ threads: { ...state.threads, [thread.id]: thread } })));
    host.on('thread.removed', ({ threadId }) =>
        set((state) => {
            const threads = { ...state.threads };
            delete threads[threadId];
            return {
                threads,
                ...(state.selectedThreadId === threadId ? { selectedThreadId: undefined, rightPanel: undefined } : {}),
            };
        }),
    );
    host.on('thread.event', ({ event }) => {
        const view = get().views[event.threadId];
        if (!view) return;
        if (!applyEvent(view, event)) {
            void resync(event.threadId);
            return;
        }
        touchView(event.threadId, view);
    });
    host.on('thread.delta', (delta) => {
        const view = get().views[delta.threadId];
        if (!view) return;
        applyDelta(view, delta);
        touchView(delta.threadId, view);
    });
    host.on('thread.item', ({ threadId, item }) => {
        const view = get().views[threadId];
        if (!view) return;
        applyLiveItem(view, item);
        touchView(threadId, view);
    });
    host.on('project.changed', ({ project }) =>
        set((state) => {
            const exists = state.projects.some((item) => item.id === project.id);
            return {
                projects: exists
                    ? state.projects.map((item) => (item.id === project.id ? project : item))
                    : [project, ...state.projects],
            };
        }),
    );
    host.on('project.removed', ({ projectId }) =>
        set((state) => ({
            projects: state.projects.filter((project) => project.id !== projectId),
            selectedProjectId: state.selectedProjectId === projectId ? undefined : state.selectedProjectId,
        })),
    );
    host.on('approval.requested', ({ approval }) =>
        set((state) => ({ approvals: [...state.approvals.filter((item) => item.id !== approval.id), approval] })),
    );
    host.on('approval.resolved', ({ approvalId }) =>
        set((state) => ({ approvals: state.approvals.filter((item) => item.id !== approvalId) })),
    );
    host.on('update.changed', ({ status }) => set({ update: status }));
    host.on('settings.changed', ({ settings }) => set({ settings }));
    host.on('connection.changed', () => void refreshConnections().catch(() => undefined));
    host.on('usage.changed', () => set((state) => ({ usageVersion: state.usageVersion + 1 })));
    host.on('ui.focusThread', ({ threadId }) => void selectThread(threadId));
    host.on('team.changed', ({ run }) => set((state) => ({ teamRuns: { ...state.teamRuns, [run.id]: run } })));
    host.on('team.removed', ({ runId }) =>
        set((state) => {
            const { [runId]: _gone, ...teamRuns } = state.teamRuns;
            return { teamRuns, ...(state.teamRunId === runId ? { teamRunId: undefined } : {}) };
        }),
    );
    host.on('workflow.removed', ({ runId }) =>
        set((state) => {
            const { [runId]: _gone, ...workflowRuns } = state.workflowRuns;
            return { workflowRuns, ...(state.workflowRunId === runId ? { workflowRunId: undefined } : {}) };
        }),
    );
    host.on('workflow.changed', ({ run }) =>
        set((state) => ({ workflowRuns: { ...state.workflowRuns, [run.id]: run } })),
    );
    host.on('member.changed', () => void loadMembers(get().selectedProjectId));
}

/** Loads the members of a project's organization (the built-in and the user's ones without a project). */
export async function loadMembers(projectId: string | undefined): Promise<void> {
    try {
        const [members, org] = await Promise.all([
            host.call('member.list', projectId ? { projectId } : {}),
            host.call('org.get', {}).catch(() => undefined),
        ]);
        set({ members, ...(org ? { org } : {}) });
    } catch {
        // An older host without members: the page stays empty.
    }
}

/** The members page in the main area, or one member on it. */
export function openMembers(memberId?: string): void {
    set({
        membersOpen: true,
        marketOpen: false,
        memberId,
        teamRunId: undefined,
        workflowRunId: undefined,
        teamsFor: undefined,
        chiefOpen: false,
        newThreadFor: undefined,
    });
    void loadMembers(get().selectedProjectId);
}

/** The talent market (19 §15): the team page's third tab. */
export function openMarket(): void {
    set({
        membersOpen: true,
        marketOpen: true,
        memberId: undefined,
        teamRunId: undefined,
        workflowRunId: undefined,
        teamsFor: undefined,
        chiefOpen: false,
        newThreadFor: undefined,
    });
    void loadMembers(get().selectedProjectId);
}

/** Connects, loads the initial state and resolves once the UI has data to show. */
export async function startApp(): Promise<void> {
    listen();
    let first: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
        first = resolve;
    });
    host.onConnection((connected) => {
        set({ connected });
        if (connected) {
            loadAll()
                .then(() => {
                    first?.();
                    first = undefined;
                })
                .catch((error) => toast(errorMessage(error), 'error'));
        }
    });
    window.xoraShell?.onHostRestarted(() => host.handleHostRestart());
    await host.connect();
    await loaded;
}

/** `teamsFor` when the team board shows the runs of every project. */
export const ALL_PROJECTS = '*';

/** The team board in the main area: the team runs of one project, or of every project, and a new run. */
export function openTeamBoard(projectId: string = ALL_PROJECTS): void {
    set({
        teamsFor: projectId,
        teamRunId: undefined,
        workflowRunId: undefined,
        membersOpen: false,
        chiefOpen: false,
        newThreadFor: undefined,
        ...(projectId !== ALL_PROJECTS ? { selectedProjectId: projectId } : {}),
    });
}

/** A team or workflow run in the main area. */
export function openRun(kind: 'team' | 'workflow', runId: string): void {
    set({
        teamRunId: kind === 'team' ? runId : undefined,
        workflowRunId: kind === 'workflow' ? runId : undefined,
        teamsFor: undefined,
        membersOpen: false,
        chiefOpen: false,
        newThreadFor: undefined,
    });
}

/** A new conversation in a project, in the main area (03): it starts with its first message. */
export function openNewThread(projectId: string): void {
    set({
        newThreadFor: projectId,
        selectedProjectId: projectId,
        teamRunId: undefined,
        workflowRunId: undefined,
        teamsFor: undefined,
        membersOpen: false,
        chiefOpen: false,
    });
}

/** Whether a thread is a conversation with the chief assistant (06 §23). */
export function isChief(thread: Pick<ThreadMeta, 'role'> | undefined): boolean {
    return thread?.role === 'chief';
}

/**
 * The chief assistant: its latest conversation, or its home (`fresh`, or when there is none) to start one.
 */
export function openChief(fresh = false): void {
    const latest = fresh
        ? undefined
        : Object.values(get().threads)
              .filter((thread) => isChief(thread) && !thread.archived)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) {
        void selectThread(latest.id);
        return;
    }
    set({
        chiefOpen: true,
        selectedThreadId: undefined,
        teamRunId: undefined,
        workflowRunId: undefined,
        teamsFor: undefined,
        membersOpen: false,
        rightPanel: undefined,
        newThreadFor: undefined,
    });
}

export async function selectThread(threadId: string | undefined): Promise<void> {
    const current = get();
    if (
        current.selectedThreadId === threadId &&
        !current.teamRunId &&
        !current.workflowRunId &&
        !current.teamsFor &&
        !current.membersOpen &&
        !current.chiefOpen &&
        !current.newThreadFor
    ) {
        return;
    }
    const thread = threadId ? current.threads[threadId] : undefined;
    // A conversation with the chief belongs to no project (06 §23): it selects none, and a project's panel left open
    // from another conversation closes.
    const chief = isChief(thread);
    set({
        selectedThreadId: threadId,
        teamRunId: undefined,
        workflowRunId: undefined,
        teamsFor: undefined,
        membersOpen: false,
        chiefOpen: false,
        newThreadFor: undefined,
        reviewTurnId: undefined,
        ...(thread && !chief ? { selectedProjectId: thread.projectId } : {}),
        ...(chief && current.rightPanel && !CHIEF_PANELS.includes(current.rightPanel) ? { rightPanel: undefined } : {}),
    });
    if (threadId && thread?.unread) {
        await attempt(() => host.call('thread.markRead', { threadId }));
    }
}

export async function createThread(projectId: string): Promise<void> {
    const thread = await attempt(() => host.call('thread.create', { projectId }));
    if (thread) {
        set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
        await selectThread(thread.id);
    }
}

export async function openProject(): Promise<void> {
    const project = await attempt(() => host.call('project.pick', {}));
    if (project) {
        set({ selectedProjectId: project.id });
    }
}

export function openReview(turnId: string): void {
    set({ rightPanel: 'changes', reviewTurnId: turnId });
}

export function openSettings(section: SettingsSection = 'general'): void {
    set({ settingsOpen: section });
}

export function attachToComposer(threadId: string, attachments: Attachment[]): void {
    set((state) => ({
        composerInbox: {
            ...state.composerInbox,
            [threadId]: [...(state.composerInbox[threadId] ?? []), ...attachments],
        },
    }));
}

export function takeComposerInbox(threadId: string): Attachment[] {
    const items = get().composerInbox[threadId] ?? [];
    if (items.length > 0) {
        set((state) => {
            const next = { ...state.composerInbox };
            delete next[threadId];
            return { composerInbox: next };
        });
    }
    return items;
}

export function openFile(path: string): void {
    set({ rightPanel: 'file', filePath: path });
}
