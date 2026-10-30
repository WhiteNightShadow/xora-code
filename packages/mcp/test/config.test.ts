import { describe, expect, it } from 'vitest';
import {
    isToolAllowed,
    isValidServerName,
    MAX_TOOL_NAME_LENGTH,
    normalizeServerName,
    parseQualifiedToolName,
    parseServerConfig,
    qualifyToolName,
} from '../src/index.ts';

const base = { enabled: true, origin: 'global', trusted: true };

describe('server configs', () => {
    it('fills in defaults for stdio, http and sse', () => {
        expect(parseServerConfig({ ...base, name: 'a', transport: 'stdio', command: 'node' })).toEqual({
            ok: true,
            config: { ...base, name: 'a', transport: 'stdio', command: 'node', args: [], env: {} },
        });
        expect(parseServerConfig({ ...base, name: 'b', transport: 'http', url: 'https://x.dev/mcp' })).toMatchObject({
            ok: true,
            config: { headers: {} },
        });
        expect(parseServerConfig({ ...base, name: 'c', transport: 'sse', url: 'http://127.0.0.1:3000/sse' }).ok).toBe(
            true,
        );
    });

    it.each([
        [{ name: '', transport: 'stdio', command: 'x' }, 'name'],
        [{ name: 'a'.repeat(41), transport: 'stdio', command: 'x' }, 'name'],
        [{ name: 'has space', transport: 'stdio', command: 'x' }, 'name'],
        [{ name: 'a__b', transport: 'stdio', command: 'x' }, 'name'],
        [{ name: 'trailing_', transport: 'stdio', command: 'x' }, 'name'],
        [{ name: 'a', transport: 'stdio', command: '' }, 'command'],
        [{ name: 'a', transport: 'http', url: 'ftp://x' }, 'url'],
        [{ name: 'a', transport: 'http', url: 'https://x', headers: { 'Bad Header': 'v' } }, 'headers'],
        [{ name: 'a', transport: 'http', url: 'https://x', headers: { ok: 'line\nbreak' } }, 'headers'],
        [{ name: 'a', transport: 'stdio', command: 'x', env: { 'A=B': '1' } }, 'env'],
        [{ name: 'a', transport: 'stdio', command: 'x', timeoutMs: 0 }, 'timeoutMs'],
        [{ name: 'a', transport: 'stdio', command: 'x', maxOutputBytes: 10 }, 'maxOutputBytes'],
        [{ name: 'a', transport: 'websocket', url: 'ws://x' }, 'transport'],
    ])('rejects %o', (fields, field) => {
        const result = parseServerConfig({ ...base, ...fields });
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toContain(field);
    });

    it('names the server in the reason', () => {
        expect(parseServerConfig({ ...base, name: 'x', transport: 'stdio' })).toEqual({
            ok: false,
            reason: 'invalid-config: x: command: Invalid input: expected string, received undefined',
        });
    });

    it('validates and normalizes names', () => {
        expect(isValidServerName('github-2_x')).toBe(true);
        expect(isValidServerName('_lead')).toBe(true);
        expect(isValidServerName('a__b')).toBe(false);
        expect(normalizeServerName('My Server!')).toBe('My-Server');
        expect(normalizeServerName('a__b___c_')).toBe('a_b_c');
        expect(normalizeServerName('服务器')).toBe('server');
        expect(normalizeServerName('x'.repeat(60))).toHaveLength(40);
    });
});

describe('tool filters', () => {
    it('lets everything through without a filter', () => {
        expect(isToolAllowed(undefined, 'anything')).toBe(true);
        expect(isToolAllowed({}, 'anything')).toBe(true);
    });

    it('applies allow lists, deny lists and globs, deny first', () => {
        const filter = { allow: ['read_*', 'list'], deny: ['read_secret*'] };
        expect(isToolAllowed(filter, 'read_file')).toBe(true);
        expect(isToolAllowed(filter, 'list')).toBe(true);
        expect(isToolAllowed(filter, 'list_all')).toBe(false);
        expect(isToolAllowed(filter, 'read_secret_key')).toBe(false);
        expect(isToolAllowed({ deny: ['*'] }, 'x')).toBe(false);
        expect(isToolAllowed({ allow: ['a.b'] }, 'aXb')).toBe(false);
    });
});

describe('qualified tool names', () => {
    it('prefixes the server and replaces characters models do not accept', () => {
        expect(qualifyToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
        expect(qualifyToolName('docs', 'search.v2 beta')).toBe('mcp__docs__search_v2_beta');
    });

    it('caps long names with a stable hash', () => {
        const long = qualifyToolName('a-server-with-a-rather-long-name-here', 'and_a_tool_name_that_goes_on_and_on');
        expect(long).toHaveLength(MAX_TOOL_NAME_LENGTH);
        expect(long).toMatch(/^mcp__a-server-with-a-rather-long-name-here__and_a_to.*_[0-9a-f]{8}$/);
        expect(qualifyToolName('a-server-with-a-rather-long-name-here', 'and_a_tool_name_that_goes_on_and_on')).toBe(
            long,
        );
    });

    it('splits a qualified name back into server and tool', () => {
        expect(parseQualifiedToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
        expect(parseQualifiedToolName('mcp___lead__x')).toEqual({ server: '_lead', tool: 'x' });
        expect(parseQualifiedToolName('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' });
        expect(parseQualifiedToolName('read_file')).toBeUndefined();
    });
});
