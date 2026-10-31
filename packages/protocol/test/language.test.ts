import { describe, expect, it } from 'vitest';
import { resolveLanguage, SettingsSchema } from '../src/index.ts';

describe('resolveLanguage', () => {
    it('keeps a chosen language whatever the system prefers', () => {
        expect(resolveLanguage('zh-CN', ['en-US'])).toBe('zh-CN');
        expect(resolveLanguage('en', ['zh-CN', 'zh-Hans-CN'])).toBe('en');
    });

    it('follows the first system language that has text', () => {
        // navigator.languages on a Chinese mac, and with --lang=en-US on the same mac.
        expect(resolveLanguage('system', ['zh-CN', 'zh-Hans-CN'])).toBe('zh-CN');
        expect(resolveLanguage('system', ['en-US', 'zh-Hans-CN'])).toBe('en');
        expect(resolveLanguage('system', ['zh-TW', 'zh-Hant-TW'])).toBe('zh-CN');
        expect(resolveLanguage('system', ['ja-JP', 'zh_CN.UTF-8'])).toBe('zh-CN');
        expect(resolveLanguage('system', ['ja-JP', 'en-GB', 'zh-Hans-CN'])).toBe('en');
    });

    it('falls back to English', () => {
        expect(resolveLanguage('system', ['ja-JP', 'fr'])).toBe('en');
        expect(resolveLanguage('system', [])).toBe('en');
    });

    it('is what the language setting accepts', () => {
        expect(SettingsSchema.shape.language.options).toEqual(['system', 'zh-CN', 'en']);
    });
});
