import { describe, expect, it } from 'vitest';
import { declaredCharset, decodeEntities, htmlToMarkdown } from '../src/index.ts';

const URL = 'https://example.com/docs/page.html';

function markdown(html: string, url = URL): string {
    return htmlToMarkdown(html, url).markdown;
}

describe('htmlToMarkdown', () => {
    it('writes headings, paragraphs, line breaks and links with absolute URLs', () => {
        expect(
            markdown(
                '<h1>Guide <a href="#top">¶</a></h1><p>Read <a href="../api/index.html">the API</a> and ' +
                    '<a href="https://other.example/x (1)">this</a>.<p>Line one<br>line two</p><h3>Next</h3>',
            ),
        ).toBe(
            [
                '# Guide ¶',
                '',
                'Read [the API](https://example.com/api/index.html) and [this](https://other.example/x%20%281%29).',
                '',
                'Line one',
                'line two',
                '',
                '### Next',
            ].join('\n'),
        );
    });

    it('keeps link text of images and drops scripts and other schemes', () => {
        expect(
            markdown(
                '<p><a href="/logo"><img src="l.png" alt="Logo"></a> <a href="javascript:void(0)">menu</a> ' +
                    '<a href="mailto:dev@example.com">mail</a> <a href="/a"><b>bold</b> <a href="/b">nested</a></a></p>',
            ),
        ).toBe(
            '[Logo](https://example.com/logo) menu [mail](mailto:dev@example.com) [bold](https://example.com/a) [nested](https://example.com/b)',
        );
    });

    it('writes nested and ordered lists, closing items browsers close', () => {
        expect(
            markdown(
                '<p>Steps:<ol start="3"><li>three<li>four<ul><li>sub one<li>sub two</ul><li><p>five</p><p>more</p></ol><p>End',
            ),
        ).toBe(
            [
                'Steps:',
                '',
                '3. three',
                '4. four',
                '   - sub one',
                '   - sub two',
                '5. five',
                '',
                '   more',
                '',
                'End',
            ].join('\n'),
        );
    });

    it('writes code blocks with their language and code spans', () => {
        expect(
            markdown(
                '<p>Call <code>run(`x`)</code>:</p><div class="highlight highlight-source-js"><pre>' +
                    '<span>const</span> a = 1;\n  if (a &lt; 2) {}\n\n```\n</pre></div>',
            ),
        ).toBe(['Call ``run(`x`)``:', '', '````js', 'const a = 1;', '  if (a < 2) {}', '', '```', '````'].join('\n'));
        expect(markdown('<pre><code class="language-Python">print(1)</code></pre>')).toBe('```python\nprint(1)\n```');
    });

    it('writes tables as rows and reads layout tables as text', () => {
        expect(
            markdown(
                '<table><caption>Sizes</caption><tr><th>Name<th>Size<tr><td>a|b<td><a href="/a">1 KB</a>' +
                    '<tr><td>c<td>2 KB</table>',
            ),
        ).toBe(
            [
                'Sizes',
                '| Name | Size |',
                '| --- | --- |',
                '| a\\|b | [1 KB](https://example.com/a) |',
                '| c | 2 KB |',
            ].join('\n'),
        );
        expect(markdown('<table><tr><td><p>Only column</p></td></tr><tr><td>More</td></tr></table>')).toBe(
            'Only column\n\nMore',
        );
    });

    it('writes quotes and decodes character references', () => {
        expect(
            markdown(
                '<p>Before</p><blockquote><p>&ldquo;Quoted&rdquo; &amp; <b>bold</b></p><p>x &lt; y &#x1F600; &#169; &unknown;</p></blockquote>',
            ),
        ).toBe(['Before', '', '> “Quoted” & bold', '>', '> x < y 😀 © &unknown;'].join('\n'));
    });

    it('leaves out scripts, styles, comments, forms, media and hidden elements', () => {
        expect(
            markdown(
                '<style>p { color: red }</style><script>document.write("<p>x</p>")</script><!-- note -->' +
                    '<noscript>Enable JavaScript</noscript><svg><text>chart</text></svg><p>Shown</p>' +
                    '<div hidden>hidden</div><div style="color: red; display:none">gone</div>' +
                    '<button>Copy</button><select><option>One</option></select><template><p>later</p></template>' +
                    '<video src="v.mp4">no video</video>',
            ),
        ).toBe('Shown');
    });

    it('takes the main content and drops navigation when the page has it', () => {
        const long = 'Content of the page. '.repeat(20).trim();
        const page = `<html><head><title> Docs  –  Example </title></head><body><header><nav><a href="/">Home</a></nav></header><main><h1>Title</h1><p>${long}</p><aside>Related</aside></main><footer>Copyright</footer></body></html>`;
        expect(htmlToMarkdown(page, URL)).toEqual({ title: 'Docs – Example', markdown: `# Title\n\n${long}` });
        const article = `<body><nav>Menu</nav><article><p>${long}</p></article><div>Comments</div></body>`;
        expect(markdown(article)).toBe(long);
        // Two articles are a list of them, not the page's content.
        expect(markdown('<body><article><p>One</p></article><article><p>Two</p></article></body>')).toBe('One\n\nTwo');
    });

    it('converts the whole page when the main part has little text and the rest much more', () => {
        expect(
            markdown(
                '<body><nav><ul><li><a href="/a">Alpha section</a></li><li><a href="/b">Beta section</a></li></ul>' +
                    '</nav><main>Loading…</main></body>',
            ),
        ).toBe('- [Alpha section](https://example.com/a)\n- [Beta section](https://example.com/b)\n\nLoading…');
    });

    it('takes the title of the document, not of an icon', () => {
        expect(htmlToMarkdown('<body><svg><title>Logo</title></svg><p>Text</p></body>', URL)).toEqual({
            title: '',
            markdown: 'Text',
        });
    });

    it('resolves links against the base element', () => {
        expect(
            markdown('<head><base href="https://cdn.example/v2/"></head><body><a href="guide.html">guide</a></body>'),
        ).toBe('[guide](https://cdn.example/v2/guide.html)');
    });

    it('survives malformed markup', () => {
        expect(markdown('<div><p>open <b>bold</div> after </span></td> <p title="a > b">t</p> a < b')).toBe(
            'open bold\n\nafter\n\nt\n\na < b',
        );
        const deep = `${'<div>'.repeat(3000)}deep${'</div>'.repeat(3000)}`;
        expect(markdown(deep)).toBe('deep');
    });
});

describe('decodeEntities', () => {
    it('decodes named and numeric references and leaves the rest', () => {
        expect(decodeEntities('&lt;a&gt; &amp;amp; &nbsp;&eacute;&Omega;&#65;&#x42;&#0; &constructor; &amp')).toBe(
            '<a> &amp;  éΩAB� &constructor; &amp',
        );
    });
});

describe('declaredCharset', () => {
    it('reads meta charset, http-equiv and XML declarations', () => {
        const bytes = (text: string) => new TextEncoder().encode(text);
        expect(declaredCharset(bytes('<html><head><meta charset="GBK">'))).toBe('gbk');
        expect(declaredCharset(bytes('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'))).toBe(
            'shift_jis',
        );
        expect(declaredCharset(bytes('<?xml version="1.0" encoding="windows-1252"?><rss/>'))).toBe('windows-1252');
        expect(declaredCharset(bytes('<html><body>none</body></html>'))).toBeUndefined();
    });
});
