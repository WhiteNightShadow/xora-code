/**
 * Environment hygiene for commands the agent runs. Child processes must not see the credentials the engine was
 * started with, so `sanitizeEnv` drops every variable whose name looks like a secret. Names are compared without
 * regard to case, as Windows does.
 *
 * Dropped:
 * - names ending in `_API_KEY`, `APIKEY`, `_KEY`, `_TOKEN` or `_SECRET`, and the bare names `KEY`, `TOKEN`;
 * - names containing `PASSWORD`, `PASSWD` or `SECRET`;
 * - AWS credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`
 *   (other `AWS_*` settings such as `AWS_PROFILE` and `AWS_REGION` stay);
 * - `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN` (already covered by `_TOKEN`, listed for clarity);
 * - every variable of model providers: `ANTHROPIC_*`, `OPENAI_*`, `DEEPSEEK_*`, `MOONSHOT_*`, `KIMI_*`, `ZHIPU*`,
 *   `GLM_*`, including endpoints and other settings, so tools the agent starts cannot reuse the engine's accounts.
 *
 * Always kept, whatever the rules say: `PATH`, `HOME` and the other variables in `KEPT_ENV_NAMES`, plus locale
 * variables (`LANG`, `LANGUAGE`, `LC_*`). Variables that only name a socket, such as `SSH_AUTH_SOCK`, match no rule
 * and stay.
 */

/** Variables passed through even if a rule would match them. */
export const KEPT_ENV_NAMES: ReadonlySet<string> = new Set([
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    'TZ',
    'LANG',
    'LANGUAGE',
    'SSH_AUTH_SOCK',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
]);

const SECRET_SUFFIX = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET)$|APIKEY$/;
const SECRET_PART = /PASSWORD|PASSWD|SECRET/;
const PROVIDER_PREFIX = /^(?:ANTHROPIC_|OPENAI_|DEEPSEEK_|MOONSHOT_|KIMI_|ZHIPU|GLM_)/;
const SECRET_NAMES: ReadonlySet<string> = new Set([
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
]);

/** Whether a variable of this name is withheld from child processes; see the module comment for the rules. */
export function isSecretEnvName(name: string): boolean {
    const upper = name.toUpperCase();
    if (KEPT_ENV_NAMES.has(upper) || upper.startsWith('LC_')) {
        return false;
    }
    return (
        SECRET_NAMES.has(upper) || PROVIDER_PREFIX.test(upper) || SECRET_SUFFIX.test(upper) || SECRET_PART.test(upper)
    );
}

/** A copy of `env` without secrets and without unset entries, ready to hand to `child_process.spawn`. */
export function sanitizeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && !isSecretEnvName(name)) {
            clean[name] = value;
        }
    }
    return clean;
}
