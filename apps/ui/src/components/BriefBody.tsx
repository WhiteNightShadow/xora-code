import { useStrings } from '../store.ts';
import { briefSections } from '../workflow-run.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';

/**
 * A run's report for whoever ordered it (06 §22): the outcome first, then what was done and the next steps. A
 * report written before shows its problems where it has no done list; one without the headings shows as it is.
 */
export function BriefBody({ text }: { text: string }) {
    const s = useStrings();
    const sections = briefSections(text);
    if (!sections) {
        return (
            <div className="wf-brief__conclusion">
                <Markdown text={text} />
            </div>
        );
    }
    const list = (items: readonly string[], ordered: boolean) => {
        const children = items.map((item) => (
            <li key={item}>
                <Markdown text={item} />
            </li>
        ));
        return ordered ? <ol>{children}</ol> : <ul>{children}</ul>;
    };
    return (
        <>
            <div className="wf-brief__conclusion">
                <Markdown text={sections.conclusion} />
            </div>
            <div className="wf-brief__grid">
                {sections.done.length > 0 || sections.problems.length === 0 ? (
                    <div className="wf-brief__block is-done">
                        <h4>
                            <Icon name="check" size={14} />
                            {s.workflow.doneTitle}
                        </h4>
                        {sections.done.length === 0 ? (
                            <p className="overview-muted">{s.workflow.noDone}</p>
                        ) : (
                            list(sections.done, false)
                        )}
                    </div>
                ) : (
                    <div className="wf-brief__block is-problems">
                        <h4>
                            <Icon name="alert" size={14} />
                            {s.workflow.problems}
                        </h4>
                        {list(sections.problems, false)}
                    </div>
                )}
                <div className="wf-brief__block is-next">
                    <h4>
                        <Icon name="send" size={14} />
                        {s.workflow.nextSteps}
                    </h4>
                    {sections.next.length === 0 ? (
                        <p className="overview-muted">{s.workflow.noNextSteps}</p>
                    ) : (
                        list(sections.next, true)
                    )}
                </div>
            </div>
        </>
    );
}
