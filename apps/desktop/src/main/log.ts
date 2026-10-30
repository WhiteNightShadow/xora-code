import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** Append-only bootstrap log with a single rotation. Synchronous on purpose: it must survive a crash. */
export class BootLog {
    readonly file: string;

    constructor(dir: string) {
        mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, 'bootstrap.log');
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

    tail(lines: number): string[] {
        try {
            return readFileSync(this.file, 'utf8').trimEnd().split('\n').slice(-lines);
        } catch {
            return [];
        }
    }

    #write(level: string, message: string): void {
        const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`;
        try {
            if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
                renameSync(this.file, `${this.file}.1`);
            }
            appendFileSync(this.file, line, 'utf8');
        } catch {
            // Logging must never take the shell down.
        }
        if (level !== 'info' || !process.env.XORA_QUIET) {
            process.stderr.write(line);
        }
    }
}
