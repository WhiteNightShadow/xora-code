import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from '../src/cli.js';
import { add, complete, format, list } from '../src/store.js';

test('add, complete and list', () => {
    let todos = add(add([], 'a'), 'b');
    todos = complete(todos, 1);
    assert.deepEqual(list(todos).map((item) => item.title), ['b']);
    assert.equal(format(todos[1]), '[ ] 2 b');
});

test('cli round trip', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'todo-')), 'todos.json');
    run(['add', 'milk'], file);
    run(['add', 'bread'], file);
    run(['done', '1'], file);
    assert.equal(run(['list'], file), '[ ] 2 bread');
});
