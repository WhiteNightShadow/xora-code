// A fake language server for the LSP tests: the base protocol over stdio, with its own framing code, and a toy
// language whose lines mean:
//   `error <text>`    an error diagnostic (code E1) on the word "error"
//   `warning <text>`  a warning (code W1)
//   `def <name>`      a function; indented `def` lines below a `class <Name>` line are its methods
// Definition finds the `def`/`class` line of the word at the position, references are every whole-word occurrence,
// both in the open documents and the other `.fake` files below the root; hover is "**<word>** (fake)".
//
// Switches: --log=<file> (one JSON line per message received), --delay=<ms> (before publishing diagnostics),
// --no-version (publish without the document version), --two-phase (errors first, everything 150 ms later),
// --crash-on=<method> (exit with code 7), --hang-on=<method> (never answer), --chunked (write in small pieces),
// --slow-start=<ms> (before answering initialize), --child=<file> (start a long-running child process and write its
// pid to the file), --ignore-exit (stay alive after shutdown, exit and the end of stdin).
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const options = {};
for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) {
        options[match[1]] = match[2] ?? true;
    }
}

const documents = new Map();
let root;
let shutdownReceived = false;
let child;
let nextId = 1;
let queue = Promise.resolve();

if (options['ignore-exit']) {
    setInterval(() => undefined, 1000);
}

function log(entry) {
    if (options.log) {
        appendFileSync(options.log, `${JSON.stringify(entry)}\n`);
    }
}

function write(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
    if (!options.chunked) {
        process.stdout.write(frame);
        return;
    }
    // Pieces of five bytes split headers and multi-byte characters alike.
    queue = queue.then(async () => {
        for (let at = 0; at < frame.length; at += 5) {
            process.stdout.write(frame.subarray(at, at + 5));
            await new Promise((resolve) => setImmediate(resolve));
        }
    });
}

const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const request = (method, params) => write({ jsonrpc: '2.0', id: `fake-${nextId++}`, method, params });

function wordAt(text, position) {
    const line = text.split('\n')[position.line] ?? '';
    for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        if (match.index <= position.character && position.character <= match.index + match[0].length) {
            return { word: match[0], start: match.index };
        }
    }
    return undefined;
}

const DECLARATION = /^(\s*)(def|class) ([A-Za-z_][A-Za-z0-9_]*)/;

/** Open documents, then the `.fake` files on disk that are not open. */
function sources() {
    const all = new Map([...documents].map(([uri, document]) => [uri, document.text]));
    if (root) {
        for (const name of readdirSync(root, { recursive: true })) {
            const file = path.join(root, String(name));
            const uri = pathToFileURL(file).href;
            if (file.endsWith('.fake') && !all.has(uri) && !String(name).includes('node_modules')) {
                all.set(uri, readFileSync(file, 'utf8'));
            }
        }
    }
    return all;
}

function declarations() {
    const found = [];
    for (const [uri, text] of sources()) {
        text.split('\n').forEach((line, index) => {
            const match = DECLARATION.exec(line);
            if (match) {
                const character = match[1].length + match[2].length + 1;
                const kind = match[2] === 'class' ? 5 : match[1].length > 0 ? 6 : 12;
                found.push({ uri, name: match[3], line: index, character, kind });
            }
        });
    }
    return found;
}

const range = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });

function diagnosticsOf(text, withWarnings) {
    const out = [];
    text.split('\n').forEach((line, index) => {
        for (const [word, severity, code] of [
            ['error', 1, 'E1'],
            ['warning', 2, 'W1'],
        ]) {
            const at = line.indexOf(`${word} `);
            if (at >= 0 && (severity === 1 || withWarnings)) {
                out.push({
                    range: range(index, at, at + word.length),
                    severity,
                    code,
                    source: 'fake',
                    message: line.slice(at + word.length + 1).trim(),
                });
            }
        }
    });
    return out;
}

function publish(uri) {
    const document = documents.get(uri);
    const version = document.version;
    const send = (diagnostics) =>
        notify('textDocument/publishDiagnostics', {
            uri,
            ...(options['no-version'] ? {} : { version }),
            diagnostics,
        });
    setTimeout(
        () => {
            // A newer text has its own report coming.
            if (documents.get(uri)?.version !== version) {
                return;
            }
            if (options['two-phase']) {
                send(diagnosticsOf(document.text, false));
                setTimeout(() => send(diagnosticsOf(document.text, true)), 150);
            } else {
                send(diagnosticsOf(document.text, true));
            }
        },
        Number(options.delay ?? 0),
    );
}

function documentSymbols(uri) {
    const document = documents.get(uri);
    if (!document) {
        return [];
    }
    const symbols = [];
    let current;
    document.text.split('\n').forEach((line, index) => {
        const match = DECLARATION.exec(line);
        if (!match) {
            return;
        }
        const start = match[1].length + match[2].length + 1;
        const symbol = {
            name: match[3],
            ...(match[2] === 'def' ? { detail: '()' } : {}),
            kind: match[2] === 'class' ? 5 : 12,
            range: range(index, 0, line.length),
            selectionRange: range(index, start, start + match[3].length),
            children: [],
        };
        if (match[1].length > 0 && current) {
            symbol.kind = 6;
            current.children.push(symbol);
            current.range = { start: current.range.start, end: { line: index, character: line.length } };
        } else {
            symbols.push(symbol);
            current = match[2] === 'class' ? symbol : undefined;
        }
    });
    return symbols;
}

async function handle(message) {
    log({ method: message.method, id: message.id, params: message.params });
    if (message.method === undefined) {
        // An answer to one of our requests.
        return;
    }
    if (options['crash-on'] === message.method) {
        process.exit(7);
    }
    if (options['hang-on'] === message.method) {
        return;
    }
    const params = message.params ?? {};
    switch (message.method) {
        case 'initialize': {
            root = params.rootUri ? fileURLToPath(params.rootUri) : undefined;
            if (options['slow-start']) {
                await new Promise((resolve) => setTimeout(resolve, Number(options['slow-start'])));
            }
            if (typeof options.child === 'string') {
                child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
                writeFileSync(options.child, String(child.pid));
            }
            respond(message.id, {
                capabilities: {
                    textDocumentSync: 1,
                    definitionProvider: true,
                    referencesProvider: true,
                    hoverProvider: true,
                    documentSymbolProvider: true,
                    workspaceSymbolProvider: true,
                },
                serverInfo: { name: 'fake-lsp', version: '1.0.0' },
            });
            // Real servers ask the client things and chat while they start.
            request('window/workDoneProgress/create', { token: 'load' });
            request('workspace/configuration', { items: [{ section: 'fake' }] });
            notify('window/logMessage', { type: 3, message: 'fake server started' });
            return;
        }
        case 'textDocument/didOpen': {
            const { uri, text, version } = params.textDocument;
            documents.set(uri, { text, version });
            publish(uri);
            return;
        }
        case 'textDocument/didChange': {
            const { uri, version } = params.textDocument;
            documents.set(uri, { text: params.contentChanges.at(-1).text, version });
            publish(uri);
            return;
        }
        case 'textDocument/didClose':
            documents.delete(params.textDocument.uri);
            return;
        case 'textDocument/definition': {
            const document = documents.get(params.textDocument.uri);
            const at = document && wordAt(document.text, params.position);
            const target = at && declarations().find((declaration) => declaration.name === at.word);
            respond(
                message.id,
                target
                    ? {
                          uri: target.uri,
                          range: range(target.line, target.character, target.character + target.name.length),
                      }
                    : null,
            );
            return;
        }
        case 'textDocument/references': {
            const document = documents.get(params.textDocument.uri);
            const at = document && wordAt(document.text, params.position);
            if (!at) {
                respond(message.id, []);
                return;
            }
            const found = [];
            const pattern = new RegExp(`\\b${at.word}\\b`, 'g');
            for (const [uri, text] of sources()) {
                text.split('\n').forEach((line, index) => {
                    for (const match of line.matchAll(pattern)) {
                        found.push({ uri, range: range(index, match.index, match.index + at.word.length) });
                    }
                });
            }
            respond(message.id, found);
            return;
        }
        case 'textDocument/hover': {
            const document = documents.get(params.textDocument.uri);
            const at = document && wordAt(document.text, params.position);
            respond(
                message.id,
                at
                    ? {
                          contents: { kind: 'markdown', value: `**${at.word}** (fake)` },
                          range: range(params.position.line, at.start, at.start + at.word.length),
                      }
                    : null,
            );
            return;
        }
        case 'textDocument/documentSymbol':
            respond(message.id, documentSymbols(params.textDocument.uri));
            return;
        case 'workspace/symbol':
            respond(
                message.id,
                declarations()
                    .filter((declaration) =>
                        declaration.name.toLowerCase().includes(String(params.query).toLowerCase()),
                    )
                    .map((declaration) => ({
                        name: declaration.name,
                        kind: declaration.kind,
                        location: {
                            uri: declaration.uri,
                            range: range(
                                declaration.line,
                                declaration.character,
                                declaration.character + declaration.name.length,
                            ),
                        },
                    })),
            );
            return;
        case 'shutdown':
            shutdownReceived = true;
            if (!options['ignore-exit']) {
                child?.kill();
            }
            respond(message.id, null);
            return;
        case 'exit':
            if (!options['ignore-exit']) {
                process.exit(shutdownReceived ? 0 : 1);
            }
            return;
        default:
            if (message.id !== undefined) {
                write({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32601, message: `no ${message.method} here` },
                });
            }
    }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
            return;
        }
        const length = Number(/content-length: *(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
        if (buffer.length < end + 4 + length) {
            return;
        }
        const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
        buffer = buffer.subarray(end + 4 + length);
        void handle(JSON.parse(body));
    }
});
process.stdin.on('end', () => {
    if (!options['ignore-exit']) {
        process.exit(shutdownReceived ? 0 : 1);
    }
});
