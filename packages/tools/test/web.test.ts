import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
    isPrivateAddress,
    parseBingRss,
    parseDuckDuckGoHtml,
    parseWebUrl,
    WEB_FETCH_MAX_CHARS,
    WEB_USER_AGENT,
    webFetchTool,
    webSearchTool,
} from '../src/index.ts';
import { makeContext, runTool, type TestContext, temporaryDir } from './helpers.ts';
import { BING_RSS, BING_RSS_OFF_TOPIC, DUCKDUCKGO_HTML } from './web-fixtures.ts';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

/** What the stubbed DNS answers; other names resolve to a public address. */
const ADDRESSES: Readonly<Record<string, string>> = {
    localhost: '127.0.0.1',
    'intranet.example': '10.0.0.5',
    'router.example': 'fe80::1',
    'mapped.example': '::ffff:192.168.1.1',
    'tailnet.example': '100.100.1.2',
    'fakeip.example': '198.18.0.7',
};

const resolve = lookup as unknown as Mock<(host: string) => Promise<Array<{ address: string; family: number }>>>;

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** The stubbed `fetch`: answers by URL and records every request. */
let routes: Map<string, Route>;
let requests: Array<{ url: string; init: RequestInit }>;

function route(url: string, answer: Route): void {
    routes.set(url, answer);
}

function page(body: ConstructorParameters<typeof Response>[0], type: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': type } });
}

function redirect(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
    routes = new Map();
    requests = [];
    resolve.mockReset();
    resolve.mockImplementation(async (host) => {
        const address = ADDRESSES[host] ?? '93.184.215.14';
        return [{ address, family: address.includes(':') ? 6 : 4 }];
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init: RequestInit = {}) => {
            const url = String(input);
            requests.push({ url, init });
            const answer = routes.get(url);
            if (!answer) {
                throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
            }
            return answer(url, init);
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function context(): Promise<TestContext> {
    return makeContext(await temporaryDir());
}

describe('isPrivateAddress', () => {
    it('flags loopback, private, link-local, multicast and broadcast addresses in every form', () => {
        for (const address of [
            '127.0.0.1',
            '127.8.9.10',
            '0.0.0.0',
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.1.1',
            '169.254.169.254',
            '224.0.0.1',
            '255.255.255.255',
            '::',
            '::1',
            '[::1]',
            'fc00::1',
            'fd12:3456::1',
            'fe80::1',
            'fe80::1%en0',
            'ff02::1',
            '::ffff:127.0.0.1',
            '::ffff:7f00:1',
            '0:0:0:0:0:ffff:a00:1',
            '::127.0.0.1',
            '64:ff9b::a00:1',
        ]) {
            expect(isPrivateAddress(address), address).toBe(true);
        }
    });

    it('leaves public addresses, shared address space and fake-ip ranges reachable', () => {
        for (const address of [
            '8.8.8.8',
            '1.1.1.1',
            '172.32.0.1',
            '192.169.0.1',
            '100.64.0.1',
            '100.127.255.254',
            '198.18.0.1',
            '198.19.255.1',
            '2606:4700:4700::1111',
            '::ffff:8.8.8.8',
            '64:ff9b::808:808',
            'example.com',
        ]) {
            expect(isPrivateAddress(address), address).toBe(false);
        }
    });
});

describe('parseWebUrl', () => {
    it('takes absolute http and https URLs only, without credentials', () => {
        expect(parseWebUrl(' https://example.com/a?b=1 ').href).toBe('https://example.com/a?b=1');
        expect(() => parseWebUrl('example.com/docs')).toThrow('Not a valid URL');
        expect(() => parseWebUrl('file:///etc/passwd')).toThrow('Only http and https');
        expect(() => parseWebUrl('ftp://example.com/x')).toThrow('Only http and https');
        expect(() => parseWebUrl('https://user:secret@example.com/')).toThrow('user name or password');
    });
});

describe('web_fetch', () => {
    it('converts a page to markdown and says where it ended up', async () => {
        route('https://example.com/docs', () => redirect('/docs/', 301));
        route('https://example.com/docs/', () =>
            page(
                '<html><head><title>Docs &amp; guides</title></head><body><nav>Menu</nav><main><h1>Install</h1>' +
                    '<p>Run <code>pnpm add x</code>, then read <a href="/api">the API</a>.</p></main></body></html>',
                'text/html; charset=utf-8',
            ),
        );
        const result = await runTool(webFetchTool, { url: 'https://example.com/docs' }, await context());
        expect(result.isError).toBe(false);
        expect(result.content).toBe(
            [
                'Title: Docs & guides',
                'URL: https://example.com/docs/ (redirected from https://example.com/docs)',
                'Status: 200',
                '',
                '# Install',
                '',
                'Run `pnpm add x`, then read [the API](https://example.com/api).',
            ].join('\n'),
        );
        expect(requests.map((request) => request.url)).toEqual([
            'https://example.com/docs',
            'https://example.com/docs/',
        ]);
        expect(requests[0]?.init).toMatchObject({ redirect: 'manual', headers: { 'user-agent': WEB_USER_AGENT } });
        expect(resolve).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
    });

    it('refuses local and private addresses before connecting', async () => {
        const ctx = await context();
        for (const [url, shown] of [
            ['http://127.0.0.1:9/status', '127.0.0.1'],
            ['http://[::1]/', '::1'],
            ['http://0x7f000001/', '127.0.0.1'],
            ['http://localhost:8080/', '127.0.0.1'],
            ['https://intranet.example/wiki', '10.0.0.5'],
            ['https://router.example/', 'fe80::1'],
            ['https://mapped.example/', '::ffff:192.168.1.1'],
        ] as const) {
            const result = await runTool(webFetchTool, { url }, ctx);
            expect(result.isError, url).toBe(true);
            expect(result.content, url).toContain(`${shown}`);
            expect(result.content, url).toContain('local or private network address');
        }
        expect(requests).toEqual([]);
    });

    it('reaches shared address space and fake-ip addresses', async () => {
        route('https://tailnet.example/', () => page('on the tailnet', 'text/plain'));
        route('https://fakeip.example/', () => page('through the proxy', 'text/plain'));
        const ctx = await context();
        expect((await runTool(webFetchTool, { url: 'https://tailnet.example/' }, ctx)).content).toContain(
            'on the tailnet',
        );
        expect((await runTool(webFetchTool, { url: 'https://fakeip.example/' }, ctx)).content).toContain(
            'through the proxy',
        );
    });

    it('checks every redirect again', async () => {
        route('https://example.com/to-local', () => redirect('http://localhost/admin'));
        route('https://example.com/to-file', () => redirect('file:///etc/passwd'));
        route('https://example.com/to-ip', () => redirect('http://169.254.169.254/latest/meta-data/'));
        const ctx = await context();
        const local = await runTool(webFetchTool, { url: 'https://example.com/to-local' }, ctx);
        expect(local).toMatchObject({ isError: true });
        expect(local.content).toContain('localhost resolves to 127.0.0.1');
        expect(local.content).toContain('Redirected to http://localhost/admin: ');
        const file = await runTool(webFetchTool, { url: 'https://example.com/to-file' }, ctx);
        expect(file.content).toBe(
            'Could not fetch https://example.com/to-file: Redirected to file:///etc/passwd: Only http and https URLs can be fetched, not file ones.',
        );
        const metadata = await runTool(webFetchTool, { url: 'https://example.com/to-ip' }, ctx);
        expect(metadata.content).toContain('169.254.169.254 is a local or private network address');
        // Only the first hop of each went out.
        expect(requests.map((request) => request.url)).toEqual([
            'https://example.com/to-local',
            'https://example.com/to-file',
            'https://example.com/to-ip',
        ]);
    });

    it('follows at most five redirects', async () => {
        for (let hop = 0; hop < 7; hop++) {
            route(`https://example.com/${hop}`, () => redirect(`/${hop + 1}`));
        }
        const result = await runTool(webFetchTool, { url: 'https://example.com/0' }, await context());
        expect(result).toMatchObject({ isError: true });
        expect(result.content).toContain('Too many redirects (more than 5)');
        expect(requests).toHaveLength(6);
    });

    it('refuses credentials and schemes other than http and https without a request', async () => {
        const ctx = await context();
        expect((await runTool(webFetchTool, { url: 'https://me:pw@example.com/' }, ctx)).isError).toBe(true);
        expect((await runTool(webFetchTool, { url: 'javascript:alert(1)' }, ctx)).isError).toBe(true);
        expect(requests).toEqual([]);
    });

    it('pretty-prints JSON, passes other text through and refuses binary files', async () => {
        route('https://api.example.com/repos', () => page('{"items":[{"name":"x","stars":3}]}', 'application/json'));
        route('https://example.com/notes.md', () => page('# Notes\n\n- one\n', 'text/markdown; charset=utf-8'));
        route('https://example.com/logo.png', () => page(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'));
        route('https://example.com/blob', () =>
            page(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]), 'application/octet-stream'),
        );
        route('https://example.com/plain', () => page('just text, no type', ''));
        const ctx = await context();
        const json = await runTool(webFetchTool, { url: 'https://api.example.com/repos' }, ctx);
        expect(json.content).toContain('Content-Type: application/json');
        expect(json.content).toContain('{\n  "items": [\n    {\n      "name": "x",\n      "stars": 3\n    }\n  ]\n}');
        const markdown = await runTool(webFetchTool, { url: 'https://example.com/notes.md' }, ctx);
        expect(markdown.content).toContain('Content-Type: text/markdown\n\n# Notes\n\n- one');
        const image = await runTool(webFetchTool, { url: 'https://example.com/logo.png' }, ctx);
        expect(image).toMatchObject({ isError: true });
        expect(image.content).toContain('image/png, a binary file');
        const blob = await runTool(webFetchTool, { url: 'https://example.com/blob' }, ctx);
        expect(blob).toMatchObject({ isError: true });
        expect(blob.content).toContain('a binary file');
        const plain = await runTool(webFetchTool, { url: 'https://example.com/plain' }, ctx);
        expect(plain.content).toContain('just text, no type');
    });

    it('decodes the charset from the header or the page', async () => {
        const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
        route('https://example.cn/meta', () =>
            page(
                Buffer.concat([
                    Buffer.from('<html><head><meta charset="gbk"><title>'),
                    gbk,
                    Buffer.from('</title></head><body><p>'),
                    gbk,
                    Buffer.from('</p></body></html>'),
                ]),
                'text/html',
            ),
        );
        route('https://example.cn/header', () => page(gbk, 'text/plain; charset=GBK'));
        const ctx = await context();
        const meta = await runTool(webFetchTool, { url: 'https://example.cn/meta' }, ctx);
        expect(meta.content).toContain('Title: 中文');
        expect(meta.content.endsWith('\n\n中文')).toBe(true);
        expect((await runTool(webFetchTool, { url: 'https://example.cn/header' }, ctx)).content).toContain('中文');
    });

    it('cuts long pages, saves the whole text and continues from start', async () => {
        const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`);
        const text = `${lines.join('\n')}\n`;
        route('https://example.com/long.txt', () => page(text, 'text/plain'));
        const ctx = await context();
        const first = await runTool(webFetchTool, { url: 'https://example.com/long.txt' }, ctx);
        const end = Number(/Call web_fetch with start: (\d+)/.exec(first.content)?.[1]);
        expect(end).toBeGreaterThan(WEB_FETCH_MAX_CHARS * 0.8);
        expect(end).toBeLessThanOrEqual(WEB_FETCH_MAX_CHARS);
        // The cut falls at a line break.
        expect(text[end - 1]).toBe('\n');
        expect(first.content).toContain(`(Showing characters 1–${end} of ${text.length}.`);
        expect(ctx.saved).toHaveLength(1);
        const saved = ctx.saved[0];
        expect(first.content).toContain(`The whole text is in ${saved?.path}`);
        const whole = await readFile(saved?.path as string, 'utf8');
        expect(whole).toContain('URL: https://example.com/long.txt');
        expect(whole).toContain(text.trimEnd());

        const next = await runTool(webFetchTool, { url: 'https://example.com/long.txt', start: end }, ctx);
        expect(next.content).toContain(`Content-Type: text/plain\n\n${text.slice(end, end + 20)}`);
        expect(next.content).toContain(`(Showing characters ${end + 1}–`);
        const past = await runTool(webFetchTool, { url: 'https://example.com/long.txt', start: 10 ** 7 }, ctx);
        expect(past).toMatchObject({ isError: true });
        expect(past.content).toContain('past the end of the text');
    });

    it('reads at most 5 MB of a body', async () => {
        route('https://example.com/huge.txt', () => page('a'.repeat(6 * 1024 * 1024), 'text/plain'));
        const result = await runTool(webFetchTool, { url: 'https://example.com/huge.txt' }, await context());
        expect(result.content).toContain('The response is larger than 5.0 MB; only its first part was read.');
        expect(result.content).toContain(`of ${5 * 1024 * 1024}.`);
    });

    it('marks error statuses, failed connections and timeouts as errors', async () => {
        route('https://example.com/missing', () => page('<h1>Not Found</h1>', 'text/html', 404));
        route('https://example.com/timeout', () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        });
        route('https://example.com/slow', (_url, init) => {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            });
        });
        const ctx = await context();
        const missing = await runTool(webFetchTool, { url: 'https://example.com/missing' }, ctx);
        expect(missing).toMatchObject({ isError: true });
        expect(missing.content).toContain('Status: 404');
        expect(missing.content).toContain('# Not Found');
        const refused = await runTool(webFetchTool, { url: 'https://nowhere.example/' }, ctx);
        expect(refused.content).toBe('Could not fetch https://nowhere.example/: The request failed: ENOTFOUND.');

        expect((await runTool(webFetchTool, { url: 'https://example.com/timeout' }, ctx)).content).toBe(
            'Could not fetch https://example.com/timeout: The request timed out after 30s.',
        );
        const stopped = runTool(webFetchTool, { url: 'https://example.com/slow' }, ctx);
        setTimeout(() => ctx.controller.abort(), 10);
        expect((await stopped).content).toBe('Could not fetch https://example.com/slow: Aborted.');
    });
});

describe('web_search', () => {
    const query = 'typescript language server';
    const bing = `https://www.bing.com/search?format=rss&setlang=en&cc=US&q=${encodeURIComponent(query)}`;
    const duckDuckGo = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    it('reads Bing RSS items', () => {
        expect(parseBingRss(BING_RSS)).toEqual([
            {
                title: 'TypeScript: JavaScript With Syntax For Types.',
                url: 'https://www.typescriptlang.org/',
                snippet: expect.stringMatching(/^TypeScript is JavaScript with syntax for types\./),
            },
            {
                title: 'TypeScript Tutorial - W3Schools',
                url: 'https://www.w3schools.com/typescript/index.php',
                snippet: expect.any(String),
            },
            {
                title: 'TypeScript - Wikipedia',
                url: 'https://en.wikipedia.org/wiki/TypeScript',
                snippet: expect.any(String),
            },
        ]);
        expect(
            parseBingRss(
                '<rss><channel><item><title><![CDATA[A &amp; B]]></title><link>https://x.example/?a=1&amp;b=2</link>' +
                    '<description>&lt;b&gt;bold&lt;/b&gt; 1 &lt; 2</description></item>' +
                    '<item><title>Not a page</title><link>javascript:void(0)</link></item></channel></rss>',
            ),
        ).toEqual([{ title: 'A &amp; B', url: 'https://x.example/?a=1&b=2', snippet: 'bold 1 < 2' }]);
    });

    it('reads DuckDuckGo results, unwraps their links and skips ads', () => {
        expect(parseDuckDuckGoHtml(DUCKDUCKGO_HTML)).toEqual([
            {
                title: 'TypeScript Language Server - GitHub',
                url: 'https://github.com/typescript-language-server/typescript-language-server',
                snippet:
                    'The TypeScript project/package includes a tsserver component which provides a custom API that can be used for gathering various intelligence about a typescript/javascript project.',
            },
            {
                title: 'typescript-language-server - npm',
                url: 'https://www.npmjs.com/package/typescript-language-server',
                snippet: expect.stringMatching(/^Language Server Protocol \(LSP\) implementation for TypeScript/),
            },
        ]);
        expect(parseDuckDuckGoHtml('<div class="no-results">No results.</div>')).toEqual([]);
    });

    it('asks Bing first and lists its results', async () => {
        route(bing, () => page(BING_RSS, 'text/xml; charset=utf-8'));
        const result = await runTool(webSearchTool, { query, count: 2 }, await context());
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe(
            [
                'Results from Bing for "typescript language server":',
                '',
                '1. TypeScript: JavaScript With Syntax For Types.',
                '   https://www.typescriptlang.org/',
                '   TypeScript is JavaScript with syntax for types. TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale.',
                '',
                '2. TypeScript Tutorial - W3Schools',
                '   https://www.w3schools.com/typescript/index.php',
                '   Become TypeScript Certified Get certified with our TypeScript exam, includes a professionally curated study kit to guide you from beginner to exam-ready.',
                '',
                'Snippets are short and may be out of date: fetch the pages you rely on with web_fetch, and cite their URLs.',
            ].join('\n'),
        );
        expect(requests.map((request) => request.url)).toEqual([bing]);
    });

    it('falls back to DuckDuckGo when Bing fails, finds nothing or answers off the topic', async () => {
        route(duckDuckGo, () => page(DUCKDUCKGO_HTML, 'text/html; charset=UTF-8'));
        for (const answer of [
            () => page('busy', 'text/plain', 503),
            () => page('<rss><channel><title>Bing</title></channel></rss>', 'text/xml'),
            () => page(BING_RSS_OFF_TOPIC, 'text/xml; charset=utf-8'),
        ]) {
            route(bing, answer);
            requests = [];
            const result = await runTool(webSearchTool, { query }, await context());
            expect(result.content).toMatch(
                /^Results from DuckDuckGo for "typescript language server":\n\n1\. TypeScript/,
            );
            expect(result.content).toContain('https://www.npmjs.com/package/typescript-language-server');
            expect(result.content).not.toContain('Typescript Courses');
            expect(requests.map((request) => request.url)).toEqual([bing, duckDuckGo]);
        }
    });

    it('says what went wrong when no engine answers', async () => {
        route(bing, () => page('busy', 'text/plain', 500));
        route(duckDuckGo, () =>
            page('<html><body><div class="no-results">No results.</div></body></html>', 'text/html'),
        );
        const result = await runTool(webSearchTool, { query }, await context());
        expect(result).toMatchObject({ isError: true });
        expect(result.content).toBe(
            'The web search found nothing for "typescript language server" (Bing: HTTP 500; DuckDuckGo: no results). Try other words, or web_fetch a page you know.',
        );
    });
});
