const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentSessionRepository } = require('../lib/electron-main/session-repository');

const appSessionId = '10000000-0000-4000-8000-000000000001';
const blockBytes = 64 * 1024;
const row = (text, kind = 'text-delta', sessionId = appSessionId) => JSON.stringify({
    schemaVersion: 1,
    event: { kind, sessionId, role: 'assistant', text }
});

function fixture(t, contents) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-history-linear-'));
    const target = path.join(root, `${appSessionId}.jsonl`);
    fs.writeFileSync(target, contents, { mode: 0o600 });
    const repository = new AgentSessionRepository(root);
    t.after(() => { repository.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    return { repository, target };
}

test('sparse history scans each complete row once instead of reparsing an expanding tail', t => {
    const invalid = row('ordinary fixture tool output '.repeat(1600), 'tool-c[REDACTED]');
    const contents = [row('oldest'), ...Array(220).fill(invalid), row('newest'), ''].join('\n');
    assert.ok(Buffer.byteLength(contents) > 8 * 1024 * 1024);
    const f = fixture(t, contents);
    const parse = JSON.parse;
    const concat = Buffer.concat;
    const read = fs.readSync;
    let parseCalls = 0;
    let parsedBytes = 0;
    let copiedBytes = 0;
    let readBytes = 0;
    JSON.parse = function (value, ...args) {
        parseCalls += 1;
        parsedBytes += Buffer.byteLength(value);
        return parse.call(this, value, ...args);
    };
    Buffer.concat = function (parts, length) {
        copiedBytes += length ?? parts.reduce((total, part) => total + part.length, 0);
        return concat.call(this, parts, length);
    };
    fs.readSync = function (...args) {
        const result = read.apply(this, args);
        readBytes += result;
        return result;
    };
    let page;
    try {
        page = f.repository.readEventPage(appSessionId, { limit: 3 });
    } finally {
        JSON.parse = parse;
        Buffer.concat = concat;
        fs.readSync = read;
    }
    assert.deepEqual(page.events.map(event => event.text), ['oldest', 'newest']);
    assert.equal(page.hasMore, false);
    assert.equal(parseCalls, 222, 'each valid or unsupported JSON line is parsed exactly once');
    assert.ok(parsedBytes <= Buffer.byteLength(contents));
    assert.equal(readBytes, Buffer.byteLength(contents), 'each source byte is read once');
    assert.ok(copiedBytes <= Buffer.byteLength(contents), 'only completed split lines are concatenated once');
    assert.equal(fs.readFileSync(f.target, 'utf8'), contents, 'paging never repairs or rewrites source data');
});

test('multi-block UTF-8 rows and partial trailing appends keep byte cursors without duplicate events', t => {
    const hugeText = '多字节🙂'.repeat(50000);
    const contents = `${row('first')}\n${row(hugeText)}\n${row('last')}\n${row('unfinished').slice(0, -2)}${'x'.repeat(blockBytes * 3)}`;
    const f = fixture(t, contents);
    const last = f.repository.readEventPage(appSessionId, { limit: 1 });
    assert.deepEqual(last.events.map(event => event.text), ['last']);
    assert.ok(last.before);
    const middle = f.repository.readEventPage(appSessionId, { before: last.before, limit: 1 });
    assert.equal(middle.events.length, 1);
    assert.equal(middle.events[0].text, hugeText);
    const first = f.repository.readEventPage(appSessionId, { before: middle.before, limit: 1 });
    assert.deepEqual(first.events.map(event => event.text), ['first']);
    assert.equal(first.hasMore, false);
});

test('unsupported and corrupt prefixes terminate pagination instead of repeating an empty cursor', t => {
    const contents = `${'bad json\n'.repeat(10000)}${row('foreign', 'text-delta', 'another-session')}\n${row('only visible')}\n`;
    const f = fixture(t, contents);
    const newest = f.repository.readEventPage(appSessionId, { limit: 1 });
    assert.deepEqual(newest.events.map(event => event.text), ['only visible']);
    assert.equal(newest.hasMore, true);
    const older = f.repository.readEventPage(appSessionId, { before: newest.before, limit: 1 });
    assert.deepEqual(older.events, []);
    assert.equal(older.hasMore, false);
    assert.equal(older.before, undefined);
});

test('newline at a scan boundary and leading blank lines do not wrap the reverse search', t => {
    const last = `${row('newest')}\n`;
    const padding = ' '.repeat(blockBytes - Buffer.byteLength(last) - 1);
    const contents = `\n${row('oldest')}\n${padding}\n${last}`;
    const f = fixture(t, contents);
    const page = f.repository.readEventPage(appSessionId, { limit: 5 });
    assert.deepEqual(page.events.map(event => event.text), ['oldest', 'newest']);
    assert.equal(page.hasMore, false);
});

test('an unterminated file has no complete events and no repeating history cursor', t => {
    const f = fixture(t, row('not durable yet'));
    const page = f.repository.readEventPage(appSessionId, { limit: 1 });
    assert.deepEqual(page.events, []);
    assert.equal(page.hasMore, false);
    assert.equal(page.before, undefined);
});
