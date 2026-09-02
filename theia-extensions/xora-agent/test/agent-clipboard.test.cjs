const assert = require('node:assert/strict');
const test = require('node:test');

const {
    htmlElementPreservesWhitespace,
    htmlFragmentToPlainText,
    parseWindowsCfHtmlClipboard,
    replaceTextSelection
} = require('../lib/browser/agent-clipboard');

const offset = value => String(value).padStart(10, '0');

function cfHtml(fragment, options = {}) {
    const startMarker = '<!--StartFragment-->';
    const endMarker = '<!--EndFragment-->';
    const html = `<html><body>${options.markers === false ? fragment : `${startMarker}${fragment}${endMarker}`}</body></html>`;
    let header = [
        'Version:1.0',
        'StartHTML:0000000000',
        'EndHTML:0000000000',
        'StartFragment:0000000000',
        'EndFragment:0000000000'
    ].join('\r\n') + '\r\n';
    const encoder = new TextEncoder();
    const startHtml = encoder.encode(header).length;
    const startFragment = startHtml + encoder.encode(html.slice(0, html.indexOf(fragment))).length;
    const endFragment = startFragment + encoder.encode(fragment).length;
    const endHtml = startHtml + encoder.encode(html).length;
    header = [
        'Version:1.0',
        `StartHTML:${offset(startHtml)}`,
        `EndHTML:${offset(endHtml)}`,
        `StartFragment:${offset(startFragment)}`,
        `EndFragment:${offset(endFragment)}`
    ].join('\r\n') + '\r\n';
    return header + html;
}

test('CF_HTML fragment markers win over stale byte offsets', () => {
    const raw = cfHtml('<p>你好&nbsp;<strong>世界</strong><br>第二行</p>')
        .replace(/StartFragment:\d{10}/, 'StartFragment:0000000001')
        .replace(/EndFragment:\d{10}/, 'EndFragment:0000000002');
    const parsed = parseWindowsCfHtmlClipboard(raw);
    assert.equal(parsed?.text, '你好 世界\n第二行');
    assert.doesNotMatch(parsed?.text ?? '', /Version:|StartHTML:/);
});

test('CF_HTML falls back to UTF-8 byte offsets when markers are absent', () => {
    const parsed = parseWindowsCfHtmlClipboard(cfHtml('<div>甲乙</div><div>emoji 😀</div>', { markers: false }));
    assert.equal(parsed?.html, '<div>甲乙</div><div>emoji 😀</div>');
    assert.equal(parsed?.text, '甲乙\nemoji 😀');
});

test('HTML conversion decodes entities, removes executable content and keeps readable lines', () => {
    assert.equal(
        htmlFragmentToPlainText('<h2>A &amp; B</h2><script>bad()</script><ul><li>一</li><li>二 &#x1F600;</li></ul>'),
        'A & B\n一\n二 😀'
    );
});

test('HTML conversion preserves code indentation, repeated spaces and inline boundaries', () => {
    assert.equal(
        htmlFragmentToPlainText('<pre>if ready:\r\n    run()</pre><p><code>const  x =  1;</code></p>'),
        'if ready:\n    run()\nconst  x =  1;'
    );
    assert.equal(htmlFragmentToPlainText('<span> leading and trailing </span>'), ' leading and trailing ');
    assert.equal(
        htmlFragmentToPlainText('<div style="color:#ddd; white-space: pre;"><div>    first()</div><div>  second()</div></div>'),
        '    first()\n  second()'
    );
    assert.equal(htmlElementPreservesWhitespace('div', 'color: red; white-space: pre-wrap'), true);
    assert.equal(htmlElementPreservesWhitespace('span', 'white-space: normal'), false);
    assert.deepEqual(replaceTextSelection('beforeafter', ' middle ', 6, 6), {
        text: 'before middle after',
        cursor: 14
    });
});

test('ordinary text and malformed lookalikes are not claimed as CF_HTML', () => {
    assert.equal(parseWindowsCfHtmlClipboard('普通粘贴文本'), undefined);
    assert.equal(parseWindowsCfHtmlClipboard('Version:1.0\nStartHTML:105\n这只是说明文字'), undefined);
    assert.equal(parseWindowsCfHtmlClipboard([
        'Version:1.0',
        'StartHTML:0000000105',
        'EndHTML:0000000200',
        'StartFragment:0000000121',
        'Unexpected:field',
        'EndFragment:0000000180',
        '<html></html>'
    ].join('\r\n')), undefined);
});

test('selection replacement preserves surrounding prompt text and returns the new caret', () => {
    assert.deepEqual(replaceTextSelection('前缀 OLD 后缀', '新内容', 3, 6), {
        text: '前缀 新内容 后缀',
        cursor: 6
    });
    assert.deepEqual(replaceTextSelection('abc', '!', undefined, undefined), {
        text: 'abc!',
        cursor: 4
    });
});
