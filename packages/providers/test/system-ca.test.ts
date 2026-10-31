import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { pemKey, trustSystemCertificates } from '../src/system-ca.ts';

function keys(type: 'default' | 'system'): Set<string> {
    return new Set(tls.getCACertificates(type).map(pemKey));
}

describe('trustSystemCertificates', () => {
    it('adds the system store to the default roots once', () => {
        const before = keys('default');
        const system = keys('system');
        const added = trustSystemCertificates();
        const after = keys('default');
        expect(added).toBe([...system].filter((key) => !before.has(key)).length);
        expect([...before, ...system].every((key) => after.has(key))).toBe(true);
        expect(after.size).toBe(before.size + added);
        expect(trustSystemCertificates()).toBe(0);
    });
});
