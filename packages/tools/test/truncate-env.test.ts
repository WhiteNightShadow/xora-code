import { describe, expect, it } from 'vitest';
import { isSecretEnvName, sanitizeEnv, truncateLine, truncateMiddle } from '../src/index.ts';

describe('truncateMiddle', () => {
    it('leaves short text alone', () => {
        expect(truncateMiddle('hello', 5)).toBe('hello');
    });

    it('keeps head and tail within the limit and says how much was cut', () => {
        const text = `${'a'.repeat(5000)}${'b'.repeat(5000)}`;
        const result = truncateMiddle(text, 1000);
        expect(result.length).toBeLessThanOrEqual(1000);
        expect(result.startsWith('aaa')).toBe(true);
        expect(result.endsWith('bbb')).toBe(true);
        const marker = /\n\[\.\.\. (\d+) characters truncated \.\.\.\]\n/.exec(result);
        expect(marker).not.toBeNull();
        // What is kept plus what the marker reports adds up to the original.
        expect(result.length - (marker?.[0].length ?? 0) + Number(marker?.[1])).toBe(text.length);
    });

    it('cuts at line breaks when one is near', () => {
        const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
        const result = truncateMiddle(lines, 600);
        const [head, tail] = result.split(/\n\[\.\.\. \d+ characters truncated \.\.\.\]\n/);
        expect(head?.split('\n').every((line) => /^line \d+$/.test(line))).toBe(true);
        expect(tail?.split('\n').every((line) => /^line \d+$/.test(line))).toBe(true);
        expect(tail?.endsWith('line 399')).toBe(true);
    });

    it('never splits a surrogate pair', () => {
        const text = '😀'.repeat(1000);
        const result = truncateMiddle(text, 301);
        expect(result.length).toBeLessThanOrEqual(301);
        expect(result).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
        expect(result).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    });
});

describe('truncateLine', () => {
    it('cuts long lines and counts the rest', () => {
        expect(truncateLine('abcdef', 4)).toBe('abcd [... 2 characters truncated]');
        expect(truncateLine('abc', 4)).toBe('abc');
        expect(truncateLine('abcd', 2, 10)).toBe('ab [... 8 characters truncated]');
    });
});

describe('sanitizeEnv', () => {
    it('drops secrets and provider settings', () => {
        const env = sanitizeEnv({
            OPENAI_API_KEY: 'x',
            OPENAI_BASE_URL: 'x',
            ANTHROPIC_AUTH_TOKEN: 'x',
            DEEPSEEK_API_KEY: 'x',
            MOONSHOT_API_KEY: 'x',
            KIMI_API_KEY: 'x',
            ZHIPUAI_API_KEY: 'x',
            GLM_API_KEY: 'x',
            GITHUB_TOKEN: 'x',
            GH_TOKEN: 'x',
            NPM_TOKEN: 'x',
            HF_TOKEN: 'x',
            CLIENT_SECRET: 'x',
            DB_PASSWORD: 'x',
            MYSQL_ROOT_PASSWD: 'x',
            SIGNING_KEY: 'x',
            SERPAPI_APIKEY: 'x',
            AWS_ACCESS_KEY_ID: 'x',
            AWS_SECRET_ACCESS_KEY: 'x',
            AWS_SESSION_TOKEN: 'x',
            TOKEN: 'x',
            openai_api_key: 'lowercase on purpose',
        });
        expect(env).toEqual({});
    });

    it('keeps ordinary variables, sockets and locale settings', () => {
        const kept = {
            PATH: '/usr/bin',
            HOME: '/home/me',
            USER: 'me',
            SHELL: '/bin/zsh',
            LANG: 'zh_CN.UTF-8',
            LC_ALL: 'zh_CN.UTF-8',
            TERM: 'xterm-256color',
            SSH_AUTH_SOCK: '/tmp/agent.sock',
            AWS_REGION: 'ap-southeast-1',
            AWS_PROFILE: 'dev',
            PWD: '/home/me',
            OLDPWD: '/',
            MONKEY: 'not a key',
            NODE_ENV: 'test',
        };
        expect(sanitizeEnv({ ...kept, UNSET: undefined })).toEqual(kept);
    });

    it('classifies names without regard to case', () => {
        expect(isSecretEnvName('github_token')).toBe(true);
        expect(isSecretEnvName('Path')).toBe(false);
        expect(isSecretEnvName('lc_ctype')).toBe(false);
    });
});
