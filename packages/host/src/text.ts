import type { UiLanguage } from '@xora/protocol';

let source: () => UiLanguage = () => 'zh-CN';

/**
 * Where host text gets its language. HostCore points it at the language setting, with `system` resolved against the
 * languages the shell reports. There is one host per process; tests start their hosts one after another.
 */
export function setLanguageSource(next: () => UiLanguage): void {
    source = next;
}

/** The language of what the host shows or sends: errors, notes, notices, reports and prompts. */
export function hostLanguage(): UiLanguage {
    return source();
}

/** The current language's half of a `bilingual` table. */
export function textOf<T>(table: Readonly<Record<UiLanguage, T>>): T {
    return table[source()];
}
