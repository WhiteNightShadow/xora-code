const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
    createPinnedLookup,
    forbiddenProviderAddressReason,
    normalizeProviderBaseUrl,
    providerModelsEndpoint,
    requestProviderJson,
    resolveSafeProviderTarget
} = require('../lib/electron-main/provider-network.js');

test('normalizes HTTPS and explicit loopback HTTP Provider URLs', () => {
    assert.equal(normalizeProviderBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
    assert.equal(normalizeProviderBaseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
    assert.equal(normalizeProviderBaseUrl('http://127.1:11434/'), 'http://127.0.0.1:11434');
    assert.equal(normalizeProviderBaseUrl('http://[::1]:11434/'), 'http://[::1]:11434');
    assert.equal(normalizeProviderBaseUrl('https://10.0.0.8/v1'), 'https://10.0.0.8/v1');
    assert.equal(providerModelsEndpoint('https://api.example.com/v1').href, 'https://api.example.com/v1/models');
});

test('rejects structurally unsafe URLs and non-loopback HTTP', () => {
    for (const url of [
        'http://api.example.com/v1',
        'http://10.0.0.8/v1',
        'ftp://localhost/v1',
        'https://user:pass@api.example.com/v1',
        'https://api.example.com/v1?key=value',
        'https://api.example.com/v1#fragment'
    ]) {
        assert.throws(() => normalizeProviderBaseUrl(url));
    }
});

test('rejects metadata names and unsafe IP literals before persistence', () => {
    for (const url of [
        'https://metadata.google.internal/computeMetadata/v1',
        'https://metadata.google.internal./computeMetadata/v1',
        'https://service.metadata.google.internal/v1',
        'https://instance-data/latest',
        'https://169.254.169.254/latest',
        'https://100.100.100.200/latest',
        'https://168.63.129.16/machine',
        'https://0.0.0.0/v1',
        'https://224.0.0.1/v1',
        'https://255.255.255.255/v1',
        'https://[::]/v1',
        'https://[fe80::1]/v1',
        'https://[ff02::1]/v1',
        'https://[::ffff:a9fe:a9fe]/v1',
        'https://[64:ff9b::a9fe:a9fe]/v1',
        'https://[fd00:ec2::254]/latest',
        'https://[fd20:ce::254]/computeMetadata/v1'
    ]) {
        assert.throws(() => normalizeProviderBaseUrl(url), undefined, url);
    }
});

test('classifies mapped, transition, link-local, unspecified and multicast addresses', () => {
    assert.match(forbiddenProviderAddressReason('::ffff:169.254.169.254'), /link-local/);
    assert.match(forbiddenProviderAddressReason('2002:a9fe:a9fe::1'), /transition/);
    assert.match(forbiddenProviderAddressReason('64:ff9b::a9fe:a9fe'), /translation/);
    assert.match(forbiddenProviderAddressReason('fe80::1234'), /link-local/);
    assert.match(forbiddenProviderAddressReason('ff05::1'), /multicast/);
    assert.match(forbiddenProviderAddressReason('0.1.2.3'), /unspecified/);
    assert.equal(forbiddenProviderAddressReason('127.0.0.1'), undefined);
    assert.equal(forbiddenProviderAddressReason('10.20.30.40'), undefined);
    assert.equal(forbiddenProviderAddressReason('2001:4860:4860::8888'), undefined);
});

test('validates every DNS answer and blocks mixed safe/rebinding answers', async () => {
    let calls = 0;
    await assert.rejects(
        resolveSafeProviderTarget(new URL('https://api.example.test/models'), async hostname => {
            calls += 1;
            assert.equal(hostname, 'api.example.test');
            return [
                { address: '203.0.113.20', family: 4 },
                { address: '169.254.169.254', family: 4 }
            ];
        }),
        /blocked link-local/
    );
    assert.equal(calls, 1);
});

test('requires loopback intent and DNS results to agree', async () => {
    await assert.rejects(
        resolveSafeProviderTarget(new URL('http://localhost:11434/models'), async () => [
            { address: '127.0.0.1', family: 4 },
            { address: '203.0.113.10', family: 4 }
        ]),
        /explicit loopback.*only to loopback/
    );
    await assert.rejects(
        resolveSafeProviderTarget(new URL('https://api.example.test/models'), async () => [
            { address: '127.0.0.1', family: 4 }
        ]),
        /cannot resolve to loopback unless loopback was explicit/
    );
});

test('pins lookup results instead of resolving a connection hostname again', async () => {
    const lookup = createPinnedLookup({ address: '203.0.113.44', family: 4 });
    const one = await new Promise((resolve, reject) => lookup('changed.example', { family: 4 }, (error, address, family) => {
        if (error) reject(error); else resolve({ address, family });
    }));
    assert.deepEqual(one, { address: '203.0.113.44', family: 4 });

    const all = await new Promise((resolve, reject) => lookup('changed-again.example', { all: true }, (error, addresses) => {
        if (error) reject(error); else resolve(addresses);
    }));
    assert.deepEqual(all, [{ address: '203.0.113.44', family: 4 }]);
});

test('production request path resolves, pins and reads JSON', async () => {
    let capturedOptions;
    const payload = await requestProviderJson(
        new URL('https://api.example.test/v1/models'),
        { authorization: 'Bearer test-secret', accept: 'application/json' },
        {
            resolver: async () => [{ address: '203.0.113.40', family: 4 }],
            requestFactory: fakeRequestFactory({ data: [{ id: 'local-model' }] }, options => { capturedOptions = options; })
        }
    );
    assert.deepEqual(payload, { data: [{ id: 'local-model' }] });
    assert.equal(capturedOptions.headers.authorization, 'Bearer test-secret');
    assert.equal(capturedOptions.agent, false);
    const pinned = await new Promise((resolve, reject) => capturedOptions.lookup('rebound.example', { family: 4 }, (error, address, family) => {
        if (error) reject(error); else resolve({ address, family });
    }));
    assert.deepEqual(pinned, { address: '203.0.113.40', family: 4 });
});

test('authenticated redirects are never followed', async () => {
    const factory = fakeRequestFactory(undefined, undefined, { statusCode: 302, headers: { location: '/credential-leak' } });
    await assert.rejects(
        requestProviderJson(new URL('https://api.example.test/models'), { authorization: 'Bearer test-secret' }, {
            resolver: async () => [{ address: '203.0.113.41', family: 4 }],
            requestFactory: factory
        }),
        /refused an authenticated redirect/
    );
    assert.equal(factory.requests(), 1);
});

test('response size and absolute deadline remain enforced', async () => {
    await assert.rejects(
        requestProviderJson(new URL('https://api.example.test/models'), {}, {
            resolver: async () => [{ address: '203.0.113.42', family: 4 }],
            requestFactory: fakeRequestFactory({ value: 'x'.repeat(512) }),
            maxResponseBytes: 64
        }),
        /exceeded 64 bytes/
    );

    await assert.rejects(
        requestProviderJson(new URL('https://api.example.test/models'), {}, {
            resolver: async () => [{ address: '203.0.113.43', family: 4 }],
            requestFactory: hangingRequestFactory,
            timeoutMs: 25
        }),
        /timed out/
    );
});

function fakeRequestFactory(body, capture, responseOverrides = {}) {
    let requests = 0;
    const factory = (_endpoint, options, onResponse) => {
        requests += 1;
        capture?.(options);
        const request = new EventEmitter();
        request.destroy = error => {
            if (error) queueMicrotask(() => request.emit('error', error));
        };
        request.end = () => queueMicrotask(() => {
            const response = new PassThrough();
            response.statusCode = responseOverrides.statusCode ?? 200;
            response.headers = responseOverrides.headers ?? {};
            onResponse(response);
            if (body === undefined) response.end();
            else response.end(JSON.stringify(body));
        });
        return request;
    };
    factory.requests = () => requests;
    return factory;
}

function hangingRequestFactory() {
    const request = new EventEmitter();
    request.destroy = error => {
        if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => undefined;
    return request;
}
