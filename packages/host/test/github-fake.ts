/** A fake GitHub for the skill hub's tests (06 §21). */

/** A small GitHub: one repository with two skills, one of them with a script. */
export const SHA = 'a'.repeat(40);
const FILES: Record<string, string> = {
    'skills/web-scraper/SKILL.md':
        '---\nname: web-scraper\ndescription: Scrape web pages politely, with retries and rate limits.\n---\nUse requests.',
    'skills/web-scraper/scripts/fetch.py': 'print("hi")\n',
    'skills/pdf-tools/SKILL.md': '---\nname: pdf-tools\ndescription: Read and fill PDF forms.\n---\nUse pypdf.',
    'README.md': '# skills\n',
};

export function fakeGitHub(): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const reply = (body: unknown, type = 'application/json') =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': type },
        });
    const impl = async (input: string | URL | Request): Promise<Response> => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        if (url.startsWith('https://api.github.com/search/repositories')) {
            return reply({
                items: [
                    {
                        full_name: 'acme/skills',
                        html_url: 'https://github.com/acme/skills',
                        stargazers_count: 1200,
                        default_branch: 'main',
                        pushed_at: '2026-10-30T00:00:00Z',
                        license: { spdx_id: 'MIT' },
                    },
                ],
            });
        }
        if (url === 'https://api.github.com/repos/acme/skills/commits/main') return reply(SHA, 'text/plain');
        if (url === `https://api.github.com/repos/acme/skills/git/trees/${SHA}?recursive=1`) {
            return reply({
                tree: [
                    ...Object.entries(FILES).map(([file, text]) => ({ path: file, type: 'blob', size: text.length })),
                    { path: 'skills', type: 'tree' },
                ],
            });
        }
        const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/([0-9a-f]{40})\/(.+)$/);
        if (raw?.[1] === SHA && raw[2] && FILES[decodeURIComponent(raw[2])] !== undefined) {
            return reply(FILES[decodeURIComponent(raw[2])], 'text/plain');
        }
        // Anything else (the mock model server) goes out as it would.
        if (!url.startsWith('https://api.github.com') && !url.startsWith('https://raw.githubusercontent.com')) {
            return fetch(input);
        }
        return new Response('not found', { status: 404 });
    };
    return { fetch: impl as typeof fetch, calls };
}
