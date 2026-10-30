import { describe, expect, it } from 'vitest';
import { isSecretName, looksLikeSecretValue, redactText, truncateMiddle } from '../src/index.ts';
import { capContent, capResourceContents } from '../src/truncate.ts';

describe('truncateMiddle', () => {
    it('keeps head and tail within the byte limit', () => {
        const text = `${'a'.repeat(5000)}${'z'.repeat(5000)}`;
        const cut = truncateMiddle(text, 1000);
        expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(1000);
        expect(cut).toMatch(/^a+\n\[\.\.\. \d+ bytes truncated \.\.\.\]\nz+$/);
        expect(truncateMiddle('short', 1000)).toBe('short');
    });

    it('never splits a UTF-8 character', () => {
        const cut = truncateMiddle('你好世界'.repeat(500), 301);
        expect(cut).not.toContain('�');
        expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(301);
    });
});

describe('capContent', () => {
    it('leaves small results alone', () => {
        const content = [{ type: 'text' as const, text: 'ok' }];
        expect(capContent(content, { ok: true }, 1024)).toEqual({
            content,
            structuredContent: { ok: true },
            truncated: false,
        });
    });

    it('keeps small blocks whole and shares the rest among large ones', () => {
        const result = capContent(
            [
                { type: 'text', text: 'header' },
                { type: 'text', text: 'x'.repeat(10_000) },
                { type: 'text', text: 'y'.repeat(10_000) },
            ],
            undefined,
            4000,
        );
        expect(result.truncated).toBe(true);
        expect(result.content[0]).toEqual({ type: 'text', text: 'header' });
        const sizes = result.content.map((block) => Buffer.byteLength((block as { text: string }).text));
        expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4000);
        expect(Math.abs((sizes[1] ?? 0) - (sizes[2] ?? 0))).toBeLessThanOrEqual(1);
    });

    it('replaces images that do not fit and drops large structured content', () => {
        const image = { type: 'image' as const, data: 'A'.repeat(50_000), mimeType: 'image/png' };
        const result = capContent([{ type: 'text', text: 'see image' }, image], { rows: 'r'.repeat(20_000) }, 10_000);
        expect(result.truncated).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(result.content).toEqual([
            { type: 'text', text: 'see image' },
            { type: 'text', text: '[image omitted: 49 KB image/png]' },
        ]);
        const kept = capContent([image, { type: 'text', text: 'z'.repeat(100_000) }], undefined, 120_000);
        expect(kept.content[0]).toBe(image);
    });

    it('caps embedded text resources and blobs in resource reads', () => {
        const result = capResourceContents(
            [
                { uri: 'file:///a.txt', text: 't'.repeat(20_000) },
                { uri: 'file:///b.bin', mimeType: 'application/zip', blob: 'B'.repeat(20_000) },
            ],
            8000,
        );
        expect(result.truncated).toBe(true);
        expect(result.contents[1]).toEqual({
            uri: 'file:///b.bin',
            mimeType: 'text/plain',
            text: '[application/zip omitted: 20 KB]',
        });
        expect(Buffer.byteLength((result.contents[0] as { text: string }).text)).toBeLessThanOrEqual(8000);
    });
});

describe('secrets', () => {
    it.each([
        ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', true],
        ['sk-proj-abcdefgh12345678', true],
        ['Bearer abcdefgh12345678', true],
        ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', true],
        ['9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', true],
        ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', true],
        ['@modelcontextprotocol/server-filesystem', false],
        ['/Users/me/projects/some-very-long-directory-name-2024', false],
        ['https://mcp.example.com/v1/endpoint/abcdef123456', false],
        ['my-very-long-database-name-for-2024-testing', false],
        ['--allowed-directories-for-the-server-123', false],
        ['debug', false],
    ])('%s looks like a secret: %s', (value, expected) => {
        expect(looksLikeSecretValue(value)).toBe(expected);
    });

    it('recognises credential names', () => {
        for (const name of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'Authorization', 'DB_PASSWORD', 'x-api-key']) {
            expect(isSecretName(name)).toBe(true);
        }
        for (const name of ['PATH', 'LOG_LEVEL', 'HOME', 'X-Region']) {
            expect(isSecretName(name)).toBe(false);
        }
    });

    it('redacts known values and inline credentials', () => {
        expect(redactText('key=hunter2hunter2 ok', ['hunter2hunter2', 'abc'])).toBe('key=[redacted] ok');
        expect(redactText('Authorization: Bearer abc.def-123456')).toBe('Authorization: Bearer [redacted]');
        expect(redactText('GET /mcp?api_key=xyz123&page=2 failed')).toBe('GET /mcp?api_key=[redacted]&page=2 failed');
        expect(redactText('token ghp_abcdefghijklmnopqrstuvwxyz0123 leaked')).toBe('token [redacted] leaked');
        expect(redactText('nothing to see')).toBe('nothing to see');
    });
});
