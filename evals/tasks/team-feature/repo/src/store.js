import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function load(file) {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function save(file, todos) {
    writeFileSync(file, `${JSON.stringify(todos, null, 2)}\n`);
}

export function add(todos, title) {
    const id = todos.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    return [...todos, { id, title, done: false }];
}

export function complete(todos, id) {
    return todos.map((item) => (item.id === id ? { ...item, done: true } : item));
}

/** Open todos by id. */
export function list(todos) {
    return todos.filter((item) => !item.done).sort((a, b) => a.id - b.id);
}

/** One line of `list`: "[ ] 1 buy milk". */
export function format(item) {
    return `${item.done ? '[x]' : '[ ]'} ${item.id} ${item.title}`;
}
