import { z } from 'zod';

/** Languages the UI and the shell have text for. */
export type UiLanguage = 'zh-CN' | 'en';

/** The language setting; `system` follows the system's preferred languages. */
export const LanguageSettingSchema = z.enum(['system', 'zh-CN', 'en']);
export type LanguageSetting = z.infer<typeof LanguageSettingSchema>;

/**
 * The language to show for a setting. `system` takes the first of `preferred` that has text (any Chinese gets
 * simplified Chinese) and falls back to English. In Electron, `navigator.languages` and
 * `[app.getLocale(), ...app.getPreferredSystemLanguages()]` both start with the app locale, which `--lang` sets.
 */
export function resolveLanguage(setting: LanguageSetting, preferred: readonly string[]): UiLanguage {
    if (setting !== 'system') {
        return setting;
    }
    for (const tag of preferred) {
        const primary = tag.split(/[-_]/)[0]?.toLowerCase();
        if (primary === 'zh') {
            return 'zh-CN';
        }
        if (primary === 'en') {
            return 'en';
        }
    }
    return 'en';
}

/** The English shape of a Chinese text table: the same keys; strings stay strings, functions keep their parameters. */
export type Mirror<T> = {
    [K in keyof T]: T[K] extends string
        ? string
        : T[K] extends (...args: infer A) => string
          ? (...args: A) => string
          : Mirror<T[K]>;
};

/** Text in both languages. The English table mirrors the Chinese one, so a missing translation is a type error. */
export function bilingual<T extends object>(zh: T, en: Mirror<T>): Readonly<Record<UiLanguage, T>> {
    return { 'zh-CN': zh, en: en as T };
}
