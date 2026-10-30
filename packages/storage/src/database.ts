import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

/**
 * The host's SQLite database (`node:sqlite`, no native module). It only holds indexes and settings: thread
 * history lives in the append-only event logs, so a broken database can be rebuilt from them.
 *
 * Migrations are additive within a major version (12 §6), so an older app bundle can still open a database
 * written by a newer one: it ignores tables and columns it does not know.
 */
export class XoraDatabase {
    readonly file: string;
    readonly #db: DatabaseSync;
    readonly #statements = new Map<string, StatementSync>();

    constructor(file: string) {
        this.file = file;
        if (file !== ':memory:') {
            mkdirSync(path.dirname(file), { recursive: true });
        }
        this.#db = new DatabaseSync(file);
        this.#db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on;');
    }

    /** Applies pending migrations and returns the resulting schema version. */
    migrate(): number {
        const current = this.schemaVersion();
        for (const migration of MIGRATIONS) {
            if (migration.version <= current) {
                continue;
            }
            this.transaction(() => {
                this.#db.exec(migration.sql);
                this.#db.exec(`pragma user_version = ${migration.version}`);
            });
        }
        return this.schemaVersion();
    }

    schemaVersion(): number {
        const row = this.#db.prepare('pragma user_version').get() as { user_version: number } | undefined;
        return row?.user_version ?? 0;
    }

    /** Highest schema version this build knows how to write. */
    static get latestVersion(): number {
        return MIGRATIONS.at(-1)?.version ?? 0;
    }

    #statement(sql: string): StatementSync {
        let statement = this.#statements.get(sql);
        if (!statement) {
            statement = this.#db.prepare(sql);
            this.#statements.set(sql, statement);
        }
        return statement;
    }

    run(sql: string, params: Record<string, SqlValue> | SqlValue[] = []): { changes: number } {
        const statement = this.#statement(sql);
        const result = Array.isArray(params) ? statement.run(...params) : statement.run(params);
        return { changes: Number(result.changes) };
    }

    get<T = Row>(sql: string, params: Record<string, SqlValue> | SqlValue[] = []): T | undefined {
        const statement = this.#statement(sql);
        return (Array.isArray(params) ? statement.get(...params) : statement.get(params)) as T | undefined;
    }

    all<T = Row>(sql: string, params: Record<string, SqlValue> | SqlValue[] = []): T[] {
        const statement = this.#statement(sql);
        return (Array.isArray(params) ? statement.all(...params) : statement.all(params)) as T[];
    }

    exec(sql: string): void {
        this.#db.exec(sql);
    }

    /** Runs `body` in a transaction; nested calls join the outer transaction. */
    transaction<T>(body: () => T): T {
        if (this.#db.isTransaction) {
            return body();
        }
        this.#db.exec('begin immediate');
        try {
            const result = body();
            this.#db.exec('commit');
            return result;
        } catch (error) {
            this.#db.exec('rollback');
            throw error;
        }
    }

    /** `pragma quick_check`; returns the problems found, empty when the file is healthy. */
    check(): string[] {
        const rows = this.#db.prepare('pragma quick_check').all() as Array<{ quick_check: string }>;
        return rows.map((row) => row.quick_check).filter((line) => line !== 'ok');
    }

    /** Consistent online copy, used before migrations and for periodic snapshots. */
    async backupTo(target: string): Promise<void> {
        mkdirSync(path.dirname(target), { recursive: true });
        await backup(this.#db, target);
    }

    close(): void {
        this.#statements.clear();
        if (this.#db.isOpen) {
            this.#db.close();
        }
    }
}

/** Serialises a value for a `*_json` column. */
export function toJson(value: unknown): string | null {
    return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Parses a `*_json` column, falling back when it is empty or unreadable. */
export function fromJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string' || value.length === 0) {
        return fallback;
    }
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}
