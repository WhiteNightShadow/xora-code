import type { Role } from './org.ts';
import type { Tier } from './schemas.ts';

/**
 * Chinese UI text: tier and role names, money, and the user's style rule (English in lower case, no spaces
 * between Chinese and English or digits).
 */

export const TIER_LABELS: Readonly<Record<Tier, string>> = {
    flagship: '旗舰',
    standard: '标准',
    economy: '经济',
    fast: '快速',
};

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
    supervisor: '主管',
    planner: '规划顾问',
    plan_reviewer: '计划评审',
    scout: '侦察',
    executor: '执行者',
    reviewer: '审查',
    specialist: '专家',
};

/** `12.30元`, `$0.50`; amounts under 0.01 keep four decimals. */
export function money(amount: number, currency: string): string {
    const value = amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2);
    if (currency === 'CNY') {
        return `${value}元`;
    }
    return currency === 'USD' ? `$${value}` : `${value}${currency.toLowerCase()}`;
}

export function percent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
}

const CJK = '[\\u3000-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]';
const CJK_THEN_LATIN = new RegExp(`(${CJK})[ \\t]+([A-Za-z0-9\`$])`, 'g');
const LATIN_THEN_CJK = new RegExp(`([A-Za-z0-9\`%])[ \\t]+(${CJK})`, 'g');
const CJK_TRAILING_SPACE = new RegExp(`(${CJK})[ \\t]+$`);
const CJK_LEADING_SPACE = new RegExp(`^[ \\t]+(${CJK})`);
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const WORD = /[A-Za-z0-9_./-]*[A-Za-z][A-Za-z0-9_./-]*/g;

/**
 * Applies the user's Chinese style to markdown: English words in lower case and no spaces between Chinese and
 * English or digits. Code spans and fenced blocks stay verbatim. Words whose case carries meaning (paths, file
 * names, camelCase identifiers) are wrapped in a code span instead of being lowercased.
 */
export function zhStyle(text: string): string {
    const parts: Array<{ readonly code: boolean; readonly text: string }> = [];
    let last = 0;
    for (const match of text.matchAll(CODE)) {
        parts.push({ code: false, text: text.slice(last, match.index) });
        parts.push({ code: true, text: match[0] });
        last = match.index + match[0].length;
    }
    parts.push({ code: false, text: text.slice(last) });
    return parts
        .map((part, index) => {
            if (part.code) {
                return part.text;
            }
            let value = part.text
                .replace(WORD, styleWord)
                .replace(CJK_THEN_LATIN, '$1$2')
                .replace(LATIN_THEN_CJK, '$1$2');
            if (parts[index + 1]?.code) {
                value = value.replace(CJK_TRAILING_SPACE, '$1');
            }
            if (parts[index - 1]?.code) {
                value = value.replace(CJK_LEADING_SPACE, '$1');
            }
            return value;
        })
        .join('');
}

function styleWord(word: string): string {
    if (!/[A-Z]/.test(word)) {
        return word;
    }
    const meaningfulCase =
        word.includes('/') ||
        word.includes('_') ||
        /[a-z][A-Z][a-z]/.test(word) ||
        (word.indexOf('.') > 0 && /\.[A-Za-z0-9]+$/.test(word));
    return meaningfulCase ? `\`${word}\`` : word.toLowerCase();
}
