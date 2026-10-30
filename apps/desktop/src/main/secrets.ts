import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

const MAGIC_ENCRYPTED = Buffer.from('XS1\n');
const MAGIC_PLAIN = Buffer.from('XP1\n');

/**
 * API keys and tokens, encrypted with Electron's `safeStorage` (Keychain on macOS, DPAPI on Windows, the
 * Secret Service on Linux). Only this process can decrypt them; the host asks for them by name.
 * Without OS encryption (e.g. Linux without a keyring) values are stored unencrypted and the UI says so.
 */
export class SecretStore {
    readonly #dir: string;
    readonly #plain: boolean;

    /** `plain` keeps values unencrypted; only unpackaged test runs use it, to never trigger keychain prompts. */
    constructor(dir: string, options: { plain?: boolean } = {}) {
        this.#dir = dir;
        this.#plain = options.plain ?? false;
    }

    /**
     * Whether values are encrypted by the OS. Deliberately does not touch the keychain: on macOS even asking
     * `isEncryptionAvailable()` reads the keychain item and can block the main thread on an access prompt.
     */
    get secure(): boolean {
        if (this.#plain) {
            return false;
        }
        if (process.platform !== 'linux') {
            return true;
        }
        const backend = safeStorage.getSelectedStorageBackend();
        return backend !== 'basic_text';
    }

    #encrypting(): boolean {
        if (this.#plain) {
            return false;
        }
        if (process.platform !== 'linux') {
            return true;
        }
        return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== 'basic_text';
    }

    #file(name: string): string {
        return path.join(this.#dir, `${name}.bin`);
    }

    get(name: string): string | null {
        let raw: Buffer;
        try {
            raw = readFileSync(this.#file(name));
        } catch {
            return null;
        }
        const magic = raw.subarray(0, 4);
        const body = raw.subarray(4);
        if (magic.equals(MAGIC_ENCRYPTED)) {
            return safeStorage.decryptString(body);
        }
        if (magic.equals(MAGIC_PLAIN)) {
            return body.toString('utf8');
        }
        return null;
    }

    set(name: string, value: string): void {
        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        const body = this.#encrypting()
            ? Buffer.concat([MAGIC_ENCRYPTED, safeStorage.encryptString(value)])
            : Buffer.concat([MAGIC_PLAIN, Buffer.from(value, 'utf8')]);
        const target = this.#file(name);
        const temp = `${target}.${process.pid}.tmp`;
        writeFileSync(temp, body, { mode: 0o600 });
        renameSync(temp, target);
    }

    delete(name: string): void {
        rmSync(this.#file(name), { force: true });
    }
}
