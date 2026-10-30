import { describe, expect, it } from 'vitest';
import { mergeEnv, safeBaseEnv } from '../src/index.ts';

describe('environment for stdio servers', () => {
    it('keeps only allowlisted variables', () => {
        const env = safeBaseEnv({
            PATH: '/usr/bin',
            HTTPS_PROXY: 'http://proxy:8080',
            OPENAI_API_KEY: 'sk-must-not-pass',
            GITHUB_TOKEN: 'ghp_must_not_pass',
            NODE_OPTIONS: '--require ./hook.js',
        });
        expect(env).toEqual({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:8080' });
    });

    it('skips exported shell functions', () => {
        expect(safeBaseEnv({ PATH: '() { :; }' })).toEqual({});
    });

    it('layers the config env over the base', () => {
        expect(mergeEnv({ PATH: '/bin', X: '1', GONE: undefined }, { X: '2', Y: '3' })).toEqual({
            PATH: '/bin',
            X: '2',
            Y: '3',
        });
    });

    it.runIf(process.platform === 'win32')('treats names case-insensitively on Windows', () => {
        expect(mergeEnv({ Path: 'C:\\old' }, { PATH: 'C:\\new' })).toEqual({ PATH: 'C:\\new' });
        expect(safeBaseEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' })).toEqual({
            Path: 'C:\\bin',
            SystemRoot: 'C:\\Windows',
        });
    });
});
