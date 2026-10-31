import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../src/cli.js';
import { format, list } from '../src/store.js';

const todos = [
    { id: 1, title: 'a', done: false, priority: 'low', due: null },
    { id: 2, title: 'b', done: false, priority: 'high', due: '2026-01-01' },
    { id: 3, title: 'c', done: true, priority: 'normal', due: null },
    { id: 4, title: 'd', done: false, priority: 'normal', due: '2026-12-31' },
];

test('hidden: priority order and status filter', () => {
    assert.deepEqual(list(todos).map((item) => item.id), [2, 4, 1]);
    assert.deepEqual(list(todos, { status: 'done' }).map((item) => item.id), [3]);
    assert.deepEqual(list(todos, { status: 'all' }).map((item) => item.id), [2, 3, 4, 1]);
});

test('hidden: format with priority and due date', () => {
    assert.equal(format(todos[1], '2026-06-01'), '[ ] 2 b (high) due 2026-01-01 !');
    assert.equal(format(todos[3], '2026-06-01'), '[ ] 4 d due 2026-12-31');
    assert.equal(format(todos[0], '2026-06-01'), '[ ] 1 a (low)');
});

test('hidden: cli flags', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'todo-')), 'todos.json');
    run(['add', 'x', '--priority', 'high', '--due', '2026-03-01'], file);
    run(['add', 'y'], file);
    run(['done', '2'], file);
    assert.equal(run(['list'], file, '2026-02-01'), '[ ] 1 x (high) due 2026-03-01');
    assert.equal(run(['list', '--status', 'done'], file, '2026-02-01'), '[x] 2 y');
});
