import { openProject, openSettings, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { WelcomeArt } from './Art.tsx';
import { Icon } from './Icon.tsx';

export function Welcome() {
    const s = useStrings();
    const connections = useApp((state) => state.connections);
    const projects = useApp((state) => state.projects);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const hasModel = connections.some((connection) => connection.hasKey || connection.presetId.startsWith('local'));
    const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0];
    return (
        <div className="welcome">
            <WelcomeArt className="welcome__art" />
            <h1>{s.welcome.title}</h1>
            <p className="welcome__subtitle">{s.welcome.subtitle}</p>
            <div className="welcome__steps">
                <button
                    type="button"
                    className={`step${hasModel ? ' is-done' : ''}`}
                    onClick={() => openSettings('models')}
                >
                    <span className="step__icon">{hasModel ? <Icon name="check" /> : '1'}</span>
                    <span className="step__title">{s.welcome.connectModel}</span>
                    <span className="step__hint">{s.welcome.connectModelHint}</span>
                </button>
                <button
                    type="button"
                    className={`step${projects.length > 0 ? ' is-done' : ''}`}
                    onClick={() => void openProject()}
                >
                    <span className="step__icon">{projects.length > 0 ? <Icon name="check" /> : '2'}</span>
                    <span className="step__title">{s.welcome.openProject}</span>
                    <span className="step__hint">{s.welcome.openProjectHint}</span>
                </button>
                <button
                    type="button"
                    className="step"
                    disabled={!project}
                    onClick={() => project && useApp.setState({ newThreadFor: project.id })}
                >
                    <span className="step__icon">3</span>
                    <span className="step__title">{s.welcome.startThread}</span>
                    <span className="step__hint">
                        {project ? format(s.welcome.moreWays, { project: project.name }) : s.welcome.ready}
                    </span>
                </button>
            </div>
        </div>
    );
}
