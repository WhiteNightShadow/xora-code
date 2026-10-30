import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

/** Patterns of secrets that must never reach a log line (10 §6); matched with boundaries to avoid noise. */
const SECRET_PATTERNS = [
    /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
    /\b(sk-ant-[A-Za-z0-9_-]{16,})\b/g,
    /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
    /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
    /("?(?:api[_-]?key|apiKey|token|secret|password)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi,
];

export function redact(text: string): string {
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, (match, prefix: string) =>
            match.startsWith(prefix) && prefix !== match ? `${prefix}[redacted]` : '[redacted]',
        );
    }
    return result;
}

export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

/** Host log at `<data>/logs/host.log`, rotated at 5 MB, with secrets redacted. Mirrors to stdout for the bootstrap. */
export class HostLog implements Logger {
    readonly #file: string | undefined;
    readonly #echo: boolean;

    constructor(dir: string | undefined, echo = true) {
        this.#echo = echo;
        if (dir) {
            mkdirSync(dir, { recursive: true });
            this.#file = path.join(dir, 'host.log');
        }
    }

    info(message: string): void {
        this.#write('info', message);
    }

    warn(message: string): void {
        this.#write('warn', message);
    }

    error(message: string): void {
        this.#write('error', message);
    }

    #write(level: string, message: string): void {
        const line = `${new Date().toISOString()} ${level} ${redact(message)}`;
        if (this.#echo) {
            (level === 'info' ? console.log : console.warn)(line);
        }
        if (!this.#file) {
            return;
        }
        try {
            if ((statSync(this.#file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
                renameSync(this.#file, `${this.#file}.1`);
            }
            appendFileSync(this.#file, `${line}\n`, 'utf8');
        } catch {
            // Logging must never take the host down.
        }
    }
}
