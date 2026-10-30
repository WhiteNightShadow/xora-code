import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_LOG_FILE, EventLog, MIGRATIONS, XoraDatabase } from '../src/index.ts';

function tempDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'xora-storage-'));
}

describe('XoraDatabase', () => {
    it('migrates a fresh file to the latest version and is idempotent', () => {
        const file = path.join(tempDir(), 'xora.db');
        const db = new XoraDatabase(file);
        expect(db.migrate()).toBe(XoraDatabase.latestVersion);
        expect(db.migrate()).toBe(XoraDatabase.latestVersion);
        expect(db.check()).toEqual([]);
        db.close();
    });

    it('runs statements and rolls back failed transactions', () => {
        const db = new XoraDatabase(':memory:');
        db.migrate();
        db.run('insert into settings (key, value_json) values (?, ?)', ['a', '1']);
        expect(() =>
            db.transaction(() => {
                db.run('insert into settings (key, value_json) values (?, ?)', ['b', '2']);
                throw new Error('boom');
            }),
        ).toThrow('boom');
        expect(db.all<{ key: string }>('select key from settings order by key').map((row) => row.key)).toEqual(['a']);
        db.close();
    });

    it('upgrades a version 1 file with the team tables', () => {
        const file = path.join(tempDir(), 'xora.db');
        const old = new XoraDatabase(file);
        old.exec(MIGRATIONS[0]?.sql ?? '');
        old.exec('pragma user_version = 1');
        old.run('insert into settings (key, value_json) values (?, ?)', ['kept', '1']);
        old.close();
        const db = new XoraDatabase(file);
        expect(db.migrate()).toBe(XoraDatabase.latestVersion);
        db.run(
            `insert into team_runs (id, org_id, goal, status, phase, created_at, updated_at, run_json)
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['r1', 'default', '加登录', 'running', 'plan', 1, 1, '{}'],
        );
        db.run('insert into team_board_events (run_id, seq, ts, task_id, type, event_json) values (?, ?, ?, ?, ?, ?)', [
            'r1',
            1,
            1,
            'T1',
            'added',
            '{}',
        ]);
        expect(db.get<{ goal: string }>('select goal from team_runs where id = ?', ['r1'])?.goal).toBe('加登录');
        expect(db.get<{ value_json: string }>('select value_json from settings where key = ?', ['kept'])).toEqual({
            value_json: '1',
        });
        expect(() =>
            db.run(
                'insert into team_board_events (run_id, seq, ts, task_id, type, event_json) values (?, ?, ?, ?, ?, ?)',
                ['r1', 1, 2, 'T1', 'status', '{}'],
            ),
        ).toThrow();
        db.close();
    });

    it('supports trigram full-text search over Chinese text', () => {
        const db = new XoraDatabase(':memory:');
        db.migrate();
        db.run('insert into thread_text (thread_id, turn_id, title, body) values (?, ?, ?, ?)', [
            't1',
            'u1',
            '重构权限',
            '把审批逻辑移到host里统一裁决',
        ]);
        const rows = db.all<{ thread_id: string }>('select thread_id from thread_text where thread_text match ?', [
            '审批逻辑',
        ]);
        expect(rows.map((row) => row.thread_id)).toEqual(['t1']);
        db.close();
    });

    it('backs up to a readable copy', async () => {
        const dir = tempDir();
        const db = new XoraDatabase(path.join(dir, 'xora.db'));
        db.migrate();
        db.run('insert into settings (key, value_json) values (?, ?)', ['k', '"v"']);
        await db.backupTo(path.join(dir, 'backups', 'copy.db'));
        db.close();
        const copy = new XoraDatabase(path.join(dir, 'backups', 'copy.db'));
        expect(copy.get<{ value_json: string }>('select value_json from settings where key = ?', ['k'])).toEqual({
            value_json: '"v"',
        });
        copy.close();
    });
});

describe('EventLog', () => {
    it('appends with increasing seq and reads after a seq', () => {
        const dir = tempDir();
        const log = EventLog.open(dir);
        log.append({ ts: 1, kind: 'a', payload: { n: 1 } });
        log.append({ ts: 2, kind: 'b', turnId: 't', payload: { n: 2 } });
        log.append({ ts: 3, kind: 'c', payload: null });
        expect(log.lastSeq).toBe(3);
        expect(log.read(1).events.map((event) => event.seq)).toEqual([2, 3]);
        log.close();
        const reopened = EventLog.open(dir);
        expect(reopened.lastSeq).toBe(3);
        expect(reopened.append({ ts: 4, kind: 'd', payload: {} }).seq).toBe(4);
        reopened.close();
    });

    it('skips lines that fail the crc', () => {
        const dir = tempDir();
        const log = EventLog.open(dir);
        log.append({ ts: 1, kind: 'a', payload: { text: 'hello' } });
        log.append({ ts: 2, kind: 'b', payload: { text: 'world' } });
        log.close();
        const file = path.join(dir, EVENT_LOG_FILE);
        writeFileSync(file, readFileSync(file, 'utf8').replace('hello', 'HELLO'));
        const report = EventLog.open(dir).read();
        expect(report.events.map((event) => event.kind)).toEqual(['b']);
        expect(report.corrupt).toBe(1);
    });

    it('cuts off a torn final line and continues the sequence', () => {
        const dir = tempDir();
        const log = EventLog.open(dir);
        log.append({ ts: 1, kind: 'a', payload: {} });
        log.close();
        appendFileSync(path.join(dir, EVENT_LOG_FILE), '{"crc":"0000');
        const reopened = EventLog.open(dir);
        expect(reopened.read().corrupt).toBe(0);
        expect(reopened.append({ ts: 2, kind: 'b', payload: {} }).seq).toBe(2);
        expect(reopened.read().events.map((event) => event.kind)).toEqual(['a', 'b']);
        reopened.close();
    });
});
