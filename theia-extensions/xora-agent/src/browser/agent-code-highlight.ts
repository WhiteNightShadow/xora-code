// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight multi-language highlighting for Agent markdown code fences.
 * Styles are pure CSS themes; tokenization stays dependency-free.
 */

export type AgentCodeHighlightStyle = 'default' | 'github' | 'monokai' | 'one-dark';

export const AGENT_CODE_HIGHLIGHT_STYLES: readonly {
    readonly id: AgentCodeHighlightStyle;
    readonly label: string;
}[] = [
    { id: 'default', label: '默认（跟随主题）' },
    { id: 'github', label: 'GitHub' },
    { id: 'monokai', label: 'Monokai' },
    { id: 'one-dark', label: 'One Dark' }
];

const STORAGE_KEY = 'xora.agent.codeHighlightStyle';

export function readAgentCodeHighlightStyle(): AgentCodeHighlightStyle {
    try {
        const value = window.localStorage.getItem(STORAGE_KEY);
        if (value === 'github' || value === 'monokai' || value === 'one-dark' || value === 'default') {
            return value;
        }
    } catch {
        // private mode / blocked storage
    }
    return 'default';
}

export function writeAgentCodeHighlightStyle(style: AgentCodeHighlightStyle): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, style);
    } catch {
        // ignore
    }
}

type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'type' | 'punctuation';

interface Token {
    readonly kind: TokenKind;
    readonly text: string;
}

const LANGUAGE_ALIASES: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    cs: 'csharp',
    'c++': 'cpp',
    'c#': 'csharp',
    golang: 'go',
    rs: 'rust',
    kt: 'kotlin',
    plaintext: 'text',
    txt: 'text'
};

const KEYWORDS: Record<string, ReadonlySet<string>> = {
    javascript: new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'.split(' ')),
    typescript: new Set('abstract as async await break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let namespace new of private protected public readonly return static super switch this throw try type typeof var void while with yield'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' ')),
    go: new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' ')),
    rust: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
    java: new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while'.split(' ')),
    bash: new Set('alias bg bind break builtin case cd command continue declare do done echo elif else enable esac eval exec exit export false fi for function getopts hash help if in jobs kill let local logout printf pwd read readonly return set shift shopt source test then time times trap true type typeset ulimit umask unalias unset until wait while'.split(' ')),
    sql: new Set('add all alter and as asc between by case create delete desc distinct drop else end exists from group having in insert into is join key left like limit not null on or order outer primary right select set table then union update values when where'.split(' ')),
    json: new Set('true false null'.split(' ')),
    yaml: new Set('true false null yes no on off'.split(' ')),
    csharp: new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' ')),
    cpp: new Set('alignas alignof and and_eq asm auto bitand bitor bool break case catch char class compl concept const consteval constexpr constinit continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'.split(' '))
};

export function normalizeHighlightLanguage(language?: string): string {
    if (!language) return 'text';
    const key = language.trim().toLowerCase();
    return LANGUAGE_ALIASES[key] ?? key;
}

export function highlightCodeToHtml(code: string, language?: string): string {
    const lang = normalizeHighlightLanguage(language);
    const tokens = tokenize(code, lang);
    return tokens.map(token => {
        if (token.kind === 'plain') return escapeHtml(token.text);
        return `<span class="xora-hl-${token.kind}">${escapeHtml(token.text)}</span>`;
    }).join('');
}

function tokenize(code: string, language: string): Token[] {
    if (language === 'text' || language === 'plain') {
        return [{ kind: 'plain', text: code }];
    }
    const keywords = KEYWORDS[language] ?? KEYWORDS.javascript;
    const lineComment = language === 'python' || language === 'bash' || language === 'yaml' || language === 'ruby'
        ? '#'
        : language === 'sql'
            ? '--'
            : '//';
    const blockComments = !(language === 'python' || language === 'bash' || language === 'yaml' || language === 'ruby' || language === 'sql');

    const tokens: Token[] = [];
    let i = 0;
    while (i < code.length) {
        // block comment
        if (blockComments && code.startsWith('/*', i)) {
            const end = code.indexOf('*/', i + 2);
            const stop = end < 0 ? code.length : end + 2;
            tokens.push({ kind: 'comment', text: code.slice(i, stop) });
            i = stop;
            continue;
        }
        // line comment
        if (code.startsWith(lineComment, i) && (i === 0 || /[\s{;(,]/.test(code[i - 1] ?? '\n') || code[i - 1] === '\n')) {
            let end = code.indexOf('\n', i);
            if (end < 0) end = code.length;
            tokens.push({ kind: 'comment', text: code.slice(i, end) });
            i = end;
            continue;
        }
        // string
        const quote = code[i];
        if (quote === '"' || quote === "'" || quote === '`') {
            let j = i + 1;
            while (j < code.length) {
                if (code[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (code[j] === quote) {
                    j += 1;
                    break;
                }
                j += 1;
            }
            tokens.push({ kind: 'string', text: code.slice(i, j) });
            i = j;
            continue;
        }
        // number
        if (/[0-9]/.test(code[i]) && (i === 0 || /[^\w$]/.test(code[i - 1]))) {
            let j = i + 1;
            while (j < code.length && /[0-9_xXa-fA-F.eE+-]/.test(code[j])) j += 1;
            tokens.push({ kind: 'number', text: code.slice(i, j) });
            i = j;
            continue;
        }
        // identifier / keyword / type-ish
        if (/[A-Za-z_$@]/.test(code[i])) {
            let j = i + 1;
            while (j < code.length && /[\w$]/.test(code[j])) j += 1;
            const word = code.slice(i, j);
            let kind: TokenKind = 'plain';
            if (keywords.has(word)) kind = 'keyword';
            else if (/^[A-Z][\w$]*$/.test(word)) kind = 'type';
            tokens.push({ kind, text: word });
            i = j;
            continue;
        }
        // punctuation
        if (/[{}()[\].,;:<>!~%^&*+=|?/\\-]/.test(code[i])) {
            tokens.push({ kind: 'punctuation', text: code[i] });
            i += 1;
            continue;
        }
        // whitespace / other
        let j = i + 1;
        while (j < code.length && !/[A-Za-z_$@0-9"'`#/{(\[\].]/.test(code[j])) j += 1;
        tokens.push({ kind: 'plain', text: code.slice(i, j) });
        i = j;
    }
    return tokens;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
