import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { host } from '../host.ts';

const components: Components = {
    a: ({ href, children }) => (
        <a
            href={href}
            onClick={(event) => {
                event.preventDefault();
                if (href && /^https?:\/\//.test(href)) {
                    void host.call('system.open', { kind: 'external', target: href }).catch(() => undefined);
                }
            }}
        >
            {children}
        </a>
    ),
    pre: ({ children }) => <pre className="md-pre">{children}</pre>,
    table: ({ children }) => (
        <div className="md-table">
            <table>{children}</table>
        </div>
    ),
};

/** Agent text: GitHub-flavoured markdown, links open in the system browser, no raw HTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
    return (
        <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
                {text}
            </ReactMarkdown>
        </div>
    );
});
