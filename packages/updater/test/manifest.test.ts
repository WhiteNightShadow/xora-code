import { describe, expect, it } from 'vitest';
import { canonicalJson, isSafeRelativePath, parseManifest, verifyManifestSignature } from '../src/index.ts';
import { temporaryDir, testKey, writeBundle } from './helpers.ts';

describe('canonicalJson', () => {
    it('sorts keys at every level and drops undefined members', () => {
        expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
            '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
        );
    });
});

describe('isSafeRelativePath', () => {
    it.each([
        ['ui/index.html', true],
        ['host/index.cjs', true],
        ['../escape.js', false],
        ['ui/../../escape.js', false],
        ['/etc/passwd', false],
        ['C:/Windows/win.ini', false],
        ['ui\\index.html', false],
        ['ui//index.html', false],
        ['./ui/index.html', false],
        ['', false],
    ])('%s → %s', (candidate, expected) => {
        expect(isSafeRelativePath(candidate)).toBe(expected);
    });
});

describe('manifest signatures', () => {
    it('accepts a manifest signed by a trusted key', async () => {
        const key = testKey();
        const { manifest } = await writeBundle(await temporaryDir(), key);
        expect(verifyManifestSignature(manifest, key.trusted)).toEqual({ ok: true, manifest });
    });

    it('rejects a manifest whose content changed after signing', async () => {
        const key = testKey();
        const { manifest } = await writeBundle(await temporaryDir(), key);
        const tampered = { ...manifest, requires: { shell: '*' } };
        expect(verifyManifestSignature(tampered, key.trusted)).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects a key that is not trusted', async () => {
        const signer = testKey();
        const other = testKey();
        const { manifest } = await writeBundle(await temporaryDir(), signer);
        expect(verifyManifestSignature(manifest, other.trusted)).toEqual({
            ok: false,
            reason: `untrusted-key:${signer.keyId}`,
        });
    });

    it('rejects an unsigned manifest', async () => {
        const key = testKey();
        const { manifest } = await writeBundle(await temporaryDir(), key);
        const { signature: _signature, ...unsigned } = manifest;
        expect(verifyManifestSignature(unsigned, key.trusted)).toEqual({ ok: false, reason: 'unsigned' });
    });

    it('rejects unsafe paths and duplicate entries when parsing', async () => {
        const key = testKey();
        const { manifest } = await writeBundle(await temporaryDir(), key);
        const escaping = { ...manifest, files: [...manifest.files, { ...manifest.files[0], path: '../x.js' }] };
        expect(parseManifest(escaping).ok).toBe(false);
        const duplicated = { ...manifest, files: [...manifest.files, manifest.files[0]] };
        expect(parseManifest(duplicated)).toMatchObject({ ok: false });
    });
});
