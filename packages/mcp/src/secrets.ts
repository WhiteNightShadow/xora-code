/**
 * Heuristics for credentials in configs and text. They only decide what to hide: a false positive costs the user
 * one re-entered value, a false negative leaks a key, so both lean towards "secret".
 */

/** Env var, header, flag or query parameter names that usually hold credentials. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|AUTH|CREDENTIAL|COOKIE|PRIVATE|SESSION/i;

/** Prefixes of well-known API key and token formats. */
const KNOWN_TOKEN =
    /^(?:sk-|sk_|rk_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|xapp-|AKIA|ASIA|AIza|ya29\.|hf_|npm_|pypi-|dop_v1_|shpat_|SG\.)[A-Za-z0-9._-]{8,}/;
const AUTH_SCHEME = /^(?:bearer|basic|token|apikey)\s+\S{8,}/i;
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;
/** Values that are clearly not tokens: paths, URLs, flags, scoped package names, Windows drive paths. */
const NOT_A_TOKEN = /^[./~@-]|:\/\/|^[A-Za-z]:[\\/]/;
/** `${VAR}`, `${env:VAR}` and `${input:id}` references that other tools expand at launch. */
export const VARIABLE_REFERENCE = /\$\{[^}]*\}/;

export function isSecretName(name: string): boolean {
    return SECRET_NAME.test(name);
}

/** Bits per character. */
function entropy(value: string): number {
    const counts = new Map<string, number>();
    for (const char of value) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    let bits = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}

/** Words joined by separators (`my-database-2024`, `src/index.js`) are names, not keys. */
function isWordy(value: string): boolean {
    return value.split(/[-_./+=]+/).every((part) => part === '' || /^(?:[a-z]+|[A-Z]+|[0-9]+)$/.test(part));
}

export function looksLikeSecretValue(raw: string): boolean {
    const value = raw.trim();
    if (KNOWN_TOKEN.test(value) || AUTH_SCHEME.test(value) || JWT.test(value)) {
        return true;
    }
    if (value.length < 24 || /\s/.test(value) || NOT_A_TOKEN.test(value)) {
        return false;
    }
    if (!/^[A-Za-z0-9+/=_.-]+$/.test(value) || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value) || isWordy(value)) {
        return false;
    }
    return entropy(value) >= 3.5;
}

/** Whether an env var, header or query parameter must not be copied: by its name, or by what its value looks like. */
export function isSecretEntry(name: string, value: string): boolean {
    return value !== '' && (isSecretName(name) || looksLikeSecretValue(value));
}

/** What a command line argument hides: nothing, its whole value, or the value after `--flag=`. */
export type SecretArg =
    | { readonly kind: 'none' }
    | { readonly kind: 'whole' }
    | { readonly kind: 'value'; readonly flag: string };

/**
 * Classifies `args[index]`: `--token=abc` hides its value, an argument after a credential flag such as `--api-key`
 * hides entirely, as does anything that looks like a key or carries an inline credential.
 */
export function secretArg(args: readonly string[], index: number): SecretArg {
    const arg = args[index] ?? '';
    const flag = /^(--?[A-Za-z0-9][\w.-]*)=(.*)$/s.exec(arg);
    if (flag?.[1] && flag[2] && isSecretEntry(flag[1], flag[2])) {
        return { kind: 'value', flag: flag[1] };
    }
    const previous = index > 0 ? args[index - 1] : undefined;
    const afterSecretFlag =
        previous !== undefined && /^--?[A-Za-z]/.test(previous) && !previous.includes('=') && isSecretName(previous);
    if ((afterSecretFlag && !arg.startsWith('-')) || looksLikeSecretValue(arg) || redactText(arg) !== arg) {
        return { kind: 'whole' };
    }
    return { kind: 'none' };
}

/** The secret parts of a command line, for redaction. */
export function secretArgValues(args: readonly string[]): string[] {
    const values: string[] = [];
    args.forEach((arg, index) => {
        const secret = secretArg(args, index);
        if (secret.kind === 'whole') {
            values.push(arg);
        } else if (secret.kind === 'value') {
            values.push(arg.slice(secret.flag.length + 1));
        }
    });
    return values;
}

const REDACTED = '[redacted]';

const INLINE_TOKENS: readonly RegExp[] = [
    /\b(Bearer|Basic|DPoP)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    /\b(?:sk-|sk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.|hf_|npm_)[A-Za-z0-9._-]{8,}/g,
    /([?&](?:[^=&#\s]*(?:key|token|secret|password|auth|code|sig)[^=&#\s]*)=)[^&#\s]+/gi,
];

/**
 * Removes `known` secrets (shorter than 6 characters are ignored) and anything that looks like an inline credential:
 * `Bearer …` values, JWTs, well-known key formats and credential-like query parameters.
 */
export function redactText(text: string, known: Iterable<string> = []): string {
    let result = text;
    const values = [...new Set(known)].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length);
    for (const value of values) {
        result = result.split(value).join(REDACTED);
    }
    for (const pattern of INLINE_TOKENS) {
        result = result.replace(pattern, (_match, prefix: unknown) => {
            if (typeof prefix !== 'string' || prefix.length === 0) {
                return REDACTED;
            }
            return prefix.endsWith('=') ? `${prefix}${REDACTED}` : `${prefix} ${REDACTED}`;
        });
    }
    return result;
}
