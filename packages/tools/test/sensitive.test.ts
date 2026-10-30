import { describe, expect, it } from 'vitest';
import { isSensitivePath } from '../src/index.ts';

const HOME = '/home/me';
const sensitive = (p: string, home = HOME): boolean => isSensitivePath(p, home);

describe('isSensitivePath', () => {
    it('flags env files but not their templates', () => {
        for (const name of ['.env', '.env.local', '.env.production', '.envrc', '.ENV']) {
            expect(sensitive(`/repo/${name}`), name).toBe(true);
        }
        for (const name of ['.env.example', '.env.sample', '.env.template', 'env.ts', 'environment.md']) {
            expect(sensitive(`/repo/${name}`), name).toBe(false);
        }
    });

    it('flags keys and certificates', () => {
        for (const name of ['server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'AuthKey.p8', 'putty.ppk', 'app.jks']) {
            expect(sensitive(`/repo/certs/${name}`), name).toBe(true);
        }
        for (const name of ['id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ecdsa_sk']) {
            expect(sensitive(`/repo/${name}`), name).toBe(true);
        }
        for (const name of ['keyboard.ts', 'monkey', 'key.md', 'pem-utils.js']) {
            expect(sensitive(`/repo/${name}`), name).toBe(false);
        }
    });

    it('flags credential stores', () => {
        for (const name of [
            '.npmrc',
            '.netrc',
            '_netrc',
            '.pypirc',
            '.git-credentials',
            '.pgpass',
            'credentials.json',
        ]) {
            expect(sensitive(`/repo/${name}`), name).toBe(true);
        }
        expect(sensitive('/repo/login.keychain-db')).toBe(true);
        expect(sensitive('/repo/exported.keychain')).toBe(true);
    });

    it('flags secret directories and files in the home directory', () => {
        expect(sensitive(`${HOME}/.ssh/config`)).toBe(true);
        expect(sensitive(`${HOME}/.ssh/known_hosts`)).toBe(true);
        expect(sensitive('/srv/backup/.ssh/authorized_keys')).toBe(true);
        expect(sensitive(`${HOME}/.aws/credentials`)).toBe(true);
        expect(sensitive(`${HOME}/.gnupg/pubring.kbx`)).toBe(true);
        expect(sensitive(`${HOME}/.docker/config.json`)).toBe(true);
        expect(sensitive(`${HOME}/.kube/config`)).toBe(true);
        expect(sensitive(`${HOME}/Library/Keychains/login.keychain-db`)).toBe(true);
        expect(sensitive('/repo/.docker/config.json')).toBe(false);
        expect(sensitive('/repo/kube/config')).toBe(false);
    });

    it('leaves ordinary files alone', () => {
        for (const file of ['/repo/src/index.ts', '/repo/README.md', `${HOME}/.zshrc`, '/repo/config/keys.ts']) {
            expect(sensitive(file), file).toBe(false);
        }
    });

    it('handles Windows paths, case and stream suffixes', () => {
        const home = 'C:\\Users\\Me';
        expect(isSensitivePath('C:\\Users\\Me\\.ssh\\id_ed25519', home)).toBe(true);
        expect(isSensitivePath('c:\\users\\me\\.AWS\\credentials', home)).toBe(true);
        expect(isSensitivePath('C:\\Users\\Me\\.docker\\config.json', home)).toBe(true);
        expect(isSensitivePath('C:\\repo\\.env.', home)).toBe(true);
        expect(isSensitivePath('C:\\repo\\server.pem:Zone.Identifier', home)).toBe(true);
        expect(isSensitivePath('C:\\repo\\src\\main.ts', home)).toBe(false);
    });
});
