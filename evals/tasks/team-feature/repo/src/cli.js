import { add, complete, format, list, load, save } from './store.js';

export function run(argv, file = 'todos.json', today = new Date().toISOString().slice(0, 10)) {
    const [command, ...rest] = argv;
    const todos = load(file);
    if (command === 'add') {
        save(file, add(todos, rest[0]));
        return 'added';
    }
    if (command === 'done') {
        save(file, complete(todos, Number(rest[0])));
        return 'done';
    }
    if (command === 'list') {
        return list(todos)
            .map((item) => format(item, today))
            .join('\n');
    }
    throw new Error(`unknown command: ${command}`);
}

if (process.argv[1]?.endsWith('cli.js')) {
    console.log(run(process.argv.slice(2)));
}
