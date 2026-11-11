import { useEffect } from 'react';
import { ChiefHome } from './components/ChiefView.tsx';
import { ConfirmHost } from './components/Confirm.tsx';
import { DispatchDialog } from './components/MembersView.tsx';
import { NewThreadPage } from './components/NewThreadDialog.tsx';
import { TeamOrgPage } from './components/OrgView.tsx';
import { Spinner } from './components/primitives.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TalentMarketPage } from './components/Talent.tsx';
import { TeamBoard, TeamStartDialog, TeamView } from './components/TeamView.tsx';
import { ThreadView } from './components/ThreadView.tsx';
import { Welcome } from './components/Welcome.tsx';
import { WorkflowRunView } from './components/WorkflowRunView.tsx';
import { RightPanel } from './panels/RightPanel.tsx';
import { UsageModal } from './panels/UsageModal.tsx';
import { SettingsModal } from './settings/SettingsModal.tsx';
import { uiLanguage, useApp, useStrings } from './store.ts';

function Toasts() {
    const toasts = useApp((state) => state.toasts);
    return (
        <div className="toasts" role="status" aria-live="polite">
            {toasts.map((toast) => (
                <div key={toast.id} className={`toast toast--${toast.kind}`}>
                    {toast.text}
                </div>
            ))}
        </div>
    );
}

export function App() {
    const s = useStrings();
    const connected = useApp((state) => state.connected);
    const ready = useApp((state) => state.ready);
    const settings = useApp((state) => state.settings);
    const thread = useApp((state) => (state.selectedThreadId ? state.threads[state.selectedThreadId] : undefined));
    const rightPanel = useApp((state) => state.rightPanel);
    const settingsOpen = useApp((state) => state.settingsOpen);
    const usageOpen = useApp((state) => state.usageOpen);
    const newThreadFor = useApp((state) => state.newThreadFor);
    const teamRunId = useApp((state) => state.teamRunId);
    const teamStartFor = useApp((state) => state.teamStartFor);
    const workflowRunId = useApp((state) => state.workflowRunId);
    const teamsFor = useApp((state) => state.teamsFor);
    const membersOpen = useApp((state) => state.membersOpen);
    const marketOpen = useApp((state) => state.marketOpen);
    const dispatchTo = useApp((state) => state.dispatchTo);
    const chiefOpen = useApp((state) => state.chiefOpen);
    // With a project and a model the home is the chief assistant (06 §23); before that, the first steps.
    const chiefHome = useApp(
        (state) =>
            state.projects.length > 0 &&
            state.connections.some((connection) => connection.hasKey || connection.presetId.startsWith('local')),
    );
    const runShown = Boolean(teamRunId || workflowRunId || teamsFor || membersOpen || chiefOpen);
    const splitIds = useApp((state) => state.split);
    const threads = useApp((state) => state.threads);
    const split = splitIds.map((id) => threads[id]).filter((item) => item !== undefined);

    useEffect(() => {
        const root = document.documentElement;
        if (!settings || settings.theme === 'system') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', settings.theme);
        root.setAttribute('data-density', settings?.density ?? 'comfortable');
        root.lang = uiLanguage(settings?.language);
        window.xoraShell?.setTheme?.(settings?.theme ?? 'system');
    }, [settings]);

    if (!ready) {
        return (
            <div className="boot">
                <Spinner size={16} /> {connected ? s.common.loading : s.app.connecting}
            </div>
        );
    }
    return (
        <div className={`app${rightPanel && thread && !runShown ? ' has-panel' : ''}`}>
            <Sidebar />
            <main className={`main${split.length > 1 ? ' main--split' : ''}`}>
                {newThreadFor ? (
                    // 03: a new conversation starts right here, from its composer.
                    <NewThreadPage key={newThreadFor} projectId={newThreadFor} />
                ) : teamRunId ? (
                    <TeamView runId={teamRunId} />
                ) : workflowRunId ? (
                    <WorkflowRunView key={workflowRunId} runId={workflowRunId} />
                ) : teamsFor ? (
                    <TeamBoard key={teamsFor} projectId={teamsFor} />
                ) : membersOpen ? (
                    // 19 §11: the organization tree; a member opens in a panel beside it. 19 §15: the talent market.
                    marketOpen ? (
                        <TalentMarketPage />
                    ) : (
                        <TeamOrgPage />
                    )
                ) : chiefOpen ? (
                    <ChiefHome />
                ) : split.length > 1 ? (
                    split.map((item) => (
                        <div key={item.id} className="split-pane">
                            <ThreadView thread={item} />
                        </div>
                    ))
                ) : thread ? (
                    <ThreadView key={thread.id} thread={thread} />
                ) : chiefHome ? (
                    <ChiefHome />
                ) : (
                    <Welcome />
                )}
            </main>
            {rightPanel && thread && !runShown && <RightPanel thread={thread} panel={rightPanel} />}
            {settingsOpen && <SettingsModal section={settingsOpen} />}
            {usageOpen && <UsageModal />}
            {teamStartFor && <TeamStartDialog projectId={teamStartFor} />}
            {dispatchTo && <DispatchDialog key={dispatchTo} memberId={dispatchTo} />}
            {!connected && <div className="banner">{s.app.disconnected}</div>}
            <Toasts />
            <ConfirmHost />
        </div>
    );
}
