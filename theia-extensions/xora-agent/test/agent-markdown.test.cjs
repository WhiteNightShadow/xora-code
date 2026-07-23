const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const React = require('@theia/core/shared/react');
const { renderToStaticMarkup } = require('react-dom/server');

const {
    AgentMarkdown,
    parseAgentMarkdown,
    parseAgentMarkdownInline
} = require('../lib/browser/agent-markdown');

test('parses headings, paragraphs and unordered or ordered lists', () => {
    const blocks = parseAgentMarkdown([
        '## 一句话总结',
        '',
        '第一行',
        '第二行',
        '',
        '- 读取项目',
        '- 汇总入口',
        '',
        '3. 修改代码',
        '4. 运行测试'
    ].join('\n'));

    assert.deepEqual(blocks, [
        { kind: 'heading', depth: 2, text: '一句话总结' },
        { kind: 'paragraph', text: '第一行\n第二行' },
        { kind: 'list', ordered: false, start: undefined, items: ['读取项目', '汇总入口'] },
        { kind: 'list', ordered: true, start: 3, items: ['修改代码', '运行测试'] }
    ]);
});

test('parses strong emphasis and inline code without interpreting raw HTML', () => {
    assert.deepEqual(parseAgentMarkdownInline('这是 **重点 `code`** 与 <script>'), [
        { kind: 'text', text: '这是 ' },
        {
            kind: 'strong',
            children: [
                { kind: 'text', text: '重点 ' },
                { kind: 'code', text: 'code' }
            ]
        },
        { kind: 'text', text: ' 与 <script>' }
    ]);
});

test('parses closed fenced code blocks with a language hint', () => {
    assert.deepEqual(parseAgentMarkdown('```ts\nconst answer = 42;\n```'), [
        {
            kind: 'code',
            code: 'const answer = 42;',
            language: 'ts',
            closed: true
        }
    ]);
});

test('keeps an unfinished streamed fence as a code block', () => {
    assert.deepEqual(parseAgentMarkdown('回复中\n\n```sh\nyarn test\n'), [
        { kind: 'paragraph', text: '回复中' },
        {
            kind: 'code',
            code: 'yarn test\n',
            language: 'sh',
            closed: false
        }
    ]);
});

test('parses aligned tables while leaving ordinary pipe text as a paragraph', () => {
    assert.deepEqual(parseAgentMarkdown([
        '| 项目 | 状态 | 耗时 |',
        '| :--- | :---: | ---: |',
        '| 构建 | **通过** | `2.4s` |',
        '| 测试 | 112/112 | 8s |'
    ].join('\n')), [{
        kind: 'table',
        headers: ['项目', '状态', '耗时'],
        rows: [
            ['构建', '**通过**', '`2.4s`'],
            ['测试', '112/112', '8s']
        ],
        alignments: ['left', 'center', 'right']
    }]);

    assert.deepEqual(parseAgentMarkdown('命令 A | 命令 B\n仍在流式输出'), [
        { kind: 'paragraph', text: '命令 A | 命令 B\n仍在流式输出' }
    ]);
});

test('renders tables as escaped semantic markup inside a horizontal scroll wrapper', () => {
    const source = '| 名称 | 内容 |\n| --- | --- |\n| **安全** | <img src=x onerror="alert(1)"> |';
    const html = renderToStaticMarkup(React.createElement(AgentMarkdown, { text: source }));

    assert.match(html, /class="xora-agent-markdown-table-wrap"/);
    assert.match(html, /<table class="xora-agent-markdown-table">/);
    assert.match(html, /<thead>/);
    assert.match(html, /<tbody>/);
    assert.match(html, /<strong>安全<\/strong>/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /<img/);
});

test('renders the supported subset with React nodes and escapes hostile HTML', () => {
    const source = '# 标题\n\n**加粗** 与 `代码`\n\n- <img src=x onerror="alert(1)">\n\n```js\n<script>alert(1)</script>\n```';
    const html = renderToStaticMarkup(React.createElement(AgentMarkdown, { text: source }));

    assert.match(html, /<h1 class="xora-agent-markdown-heading">标题<\/h1>/);
    assert.match(html, /<strong>加粗<\/strong>/);
    assert.match(html, /xora-agent-markdown-inline-code/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    // Syntax highlighting may wrap punctuation and literals in safe spans, so
    // assert the escaped token sequence rather than requiring one contiguous
    // text node. The stronger invariant below still rejects real HTML nodes.
    assert.match(html, /<code[^>]*>[\s\S]*&lt;[\s\S]*script[\s\S]*alert[\s\S]*&lt;[\s\S]*\/[\s\S]*script/);
    assert.doesNotMatch(html, /<script>|<img/);

    const implementation = fs.readFileSync(path.join(__dirname, '../src/browser/agent-markdown.tsx'), 'utf8');
    const highlighter = fs.readFileSync(path.join(__dirname, '../src/browser/agent-code-highlight.ts'), 'utf8');
    assert.match(implementation, /const html = highlightCodeToHtml\(block\.code, language\)/);
    assert.match(implementation, /dangerouslySetInnerHTML=\{\{ __html: html \}\}/);
    assert.match(highlighter, /escapeHtml\(token\.text\)/,
        'every syntax-highlight token must be escaped before entering the React HTML boundary');
});

test('marks an unfinished fenced block for streaming presentation', () => {
    const html = renderToStaticMarkup(React.createElement(AgentMarkdown, { text: '```\npartial' }));
    assert.match(html, /class="[^"]*\bxora-agent-markdown-code\b[^"]*\bis-streaming\b[^"]*"/);
    assert.match(html, /data-streaming="true"/);
    assert.match(html, />partial<\/code>/);
});
