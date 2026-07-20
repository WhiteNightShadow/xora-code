const assert = require('node:assert/strict');
const test = require('node:test');

const {
    deepRedact,
    StreamingOpaquePayloadRedactor
} = require('../lib/electron-main/session-repository');

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const sha256 = 'a'.repeat(64);

test('diagnostic redaction removes opaque image Base64 while retaining SHA-256 metadata', () => {
    const redacted = deepRedact(`request={"data":"${image}","sha256":"${sha256}"}`);

    assert.equal(redacted.includes(image), false);
    assert.match(redacted, /\[REDACTED_BINARY_PAYLOAD\]/);
    assert.match(redacted, new RegExp(sha256));
});

test('diagnostic redaction permits only exact 64-character hexadecimal digests', () => {
    assert.equal(deepRedact(sha256), sha256);
    for (const opaqueHex of ['b'.repeat(65), 'c'.repeat(128)]) {
        const redacted = deepRedact(opaqueHex);
        assert.equal(redacted, '[REDACTED_BINARY_PAYLOAD]');
        assert.equal(redacted.includes(opaqueHex), false);
    }
});

test('streaming diagnostic redaction removes Base64 across arbitrary chunks', () => {
    const input = `request={"data":"${image}"}\n`;
    const chunkings = [
        [input],
        Array.from(input),
        Array.from({ length: Math.ceil(input.length / 7) }, (_, index) => input.slice(index * 7, index * 7 + 7))
    ];

    for (const chunks of chunkings) {
        const redactor = new StreamingOpaquePayloadRedactor();
        const output = chunks.map(chunk => redactor.write(chunk)).join('') + redactor.end();
        assert.equal(output.includes(image), false);
        assert.equal(output.includes(image.slice(0, 32)), false);
        assert.match(output, /\[REDACTED_BINARY_PAYLOAD\]/);
    }
});

test('streaming diagnostic redaction keeps wrapped JSON data sensitive through its closing quote', () => {
    const wrapped = image.match(/.{1,32}/g).join('\n');
    const escapedAndWrapped = `${image.slice(0, 32)}\\n${image.slice(32, 64)}\\\"${image.slice(64)}`;
    const inputs = [
        `request={"data":"${wrapped}","status":"safe"}\n`,
        `request={ "data" : "${escapedAndWrapped}", "status":"safe" }\n`
    ];

    for (const input of inputs) {
        const redactor = new StreamingOpaquePayloadRedactor();
        const output = Array.from(input).map(character => redactor.write(character)).join('') + redactor.end();
        assert.equal(output.includes(image.slice(0, 32)), false);
        assert.equal(output.includes(image.slice(32, 64)), false);
        assert.equal(output.match(/\[REDACTED_BINARY_PAYLOAD\]/g)?.length, 1);
        assert.match(output, /"data"\s*:\s*"\[REDACTED_BINARY_PAYLOAD\]"/);
        assert.match(output, /"status":"safe"/);
    }
});

test('streaming diagnostic redaction retains SHA-256 but rejects longer hexadecimal streams', () => {
    const redactCharacters = value => {
        const redactor = new StreamingOpaquePayloadRedactor();
        return Array.from(value).map(character => redactor.write(character)).join('') + redactor.end();
    };

    assert.equal(redactCharacters(`${sha256}\n`), `${sha256}\n`);
    assert.equal(redactCharacters(`sha256=${sha256}\n`), `sha256=${sha256}\n`);
    assert.equal(redactCharacters(`${'d'.repeat(65)}\n`), '[REDACTED_BINARY_PAYLOAD]\n');
    assert.equal(redactCharacters(`${'e'.repeat(1024)}\n`), '[REDACTED_BINARY_PAYLOAD]\n');
});
