import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CredentialAccessError, runCredentialHelper } from './credential-helper-client';

interface VaultFile {
    schemaVersion: 1;
    values: Record<string, string>;
}

export interface CredentialSnapshot {
    encrypted?: string;
    sessionValue?: string;
}

export class SecretVault {
    protected readonly sessionValues = new Map<string, string>();
    protected readonly unlockedValues = new Map<string, { encrypted: string; value: string }>();
    protected readonly preparedEncryptions = new Map<string, string | undefined>();
    protected credentialQueue: Promise<void> = Promise.resolve();
    protected persistentAvailable = false;
    protected readonly filePath = path.join(app.getPath('userData'), 'security', 'secrets.json');
    protected readonly lockPath = path.join(app.getPath('userData'), 'security', '.secrets.lock');
    protected readonly recoveryPath = path.join(app.getPath('userData'), 'security', '.credential-recovery.json');

    /** Last helper result only; checking availability must never open Keychain. */
    isPersistentStorageAvailable(): boolean {
        return this.persistentAvailable;
    }

    /** Checks encrypted credential presence without opening macOS Keychain. */
    has(secretRef: string): boolean {
        this.assertRef(secretRef);
        return this.sessionValues.has(secretRef) || typeof this.readFile().values[secretRef] === 'string';
    }

    /** Await before entering the synchronous Provider transaction/launch lock. */
    prepare(secretRefs: string[], options: { retry?: boolean } = {}): Promise<void> {
        for (const reference of secretRefs) this.assertRef(reference);
        return this.enqueuePreparation(() => this.prepareUnlocked([...new Set(secretRefs)], [], options.retry === true));
    }

    /** Stages ciphertext without ever holding the Provider lock during OS authorization. */
    prepareSet(value: string): Promise<void> {
        this.assertValue(value);
        return this.enqueuePreparation(() => this.prepareUnlocked([], [value], true));
    }

    protected enqueuePreparation(operation: () => Promise<void>): Promise<void> {
        const result = this.credentialQueue.then(operation);
        this.credentialQueue = result.catch(() => undefined);
        return result;
    }

    protected async prepareUnlocked(secretRefs: string[], values: string[], retry: boolean): Promise<void> {
        const vault = this.readFile();
        const encrypted = secretRefs.flatMap(reference => {
            const ciphertext = vault.values[reference];
            if (this.sessionValues.has(reference) || !ciphertext
                || this.unlockedValues.get(reference)?.encrypted === ciphertext) return [];
            return [{ reference, ciphertext }];
        });
        const plain = values.filter(value => !this.preparedEncryptions.has(value));
        if (!encrypted.length && !plain.length) return;
        if (!retry && fs.existsSync(this.recoveryPath)) {
            throw new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED');
        }
        if (!app.isPackaged && process.env.XORA_DISABLE_SAFE_STORAGE === '1') {
            if (encrypted.length) throw new CredentialAccessError('CREDENTIAL_STORAGE_UNAVAILABLE');
            for (const value of plain) this.stageEncryption(value, undefined);
            return;
        }
        // Keep a non-secret circuit marker across a crash or force quit. The
        // next startup will not replay a stuck OS authorization automatically.
        fs.mkdirSync(path.dirname(this.recoveryPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.recoveryPath, JSON.stringify({ schemaVersion: 1, interruptedAt: new Date().toISOString() }), { mode: 0o600 });
        try {
            const result = await this.runHelper({
                decrypt: encrypted.map(entry => entry.ciphertext),
                encrypt: plain
            });
            const current = this.readFile();
            if (encrypted.some(entry => current.values[entry.reference] !== entry.ciphertext)) {
                throw new CredentialAccessError('CREDENTIAL_STORE_CHANGED');
            }
            encrypted.forEach((entry, index) => this.unlockedValues.set(entry.reference, {
                encrypted: entry.ciphertext,
                value: result.decrypted[index]
            }));
            plain.forEach((value, index) => this.stageEncryption(value, result.encrypted[index]));
            this.persistentAvailable = true;
            this.clearRecoveryMarker();
        } catch (error) {
            if (error instanceof CredentialAccessError && error.code === 'CREDENTIAL_STORAGE_UNAVAILABLE' && !encrypted.length) {
                // Preserve the existing session-only mode when no secure OS
                // backend exists. Never persist a plaintext or basic_text key.
                this.persistentAvailable = false;
                for (const value of plain) this.stageEncryption(value, undefined);
                return;
            }
            throw error;
        }
    }

    protected runHelper = runCredentialHelper;

    protected stageEncryption(value: string, encrypted: string | undefined): void {
        // Invalid/cancelled settings saves must not accumulate plaintext
        // staging entries for the whole application lifetime.
        while (this.preparedEncryptions.size >= 32) {
            this.preparedEncryptions.delete(this.preparedEncryptions.keys().next().value!);
        }
        this.preparedEncryptions.set(value, encrypted);
    }

    set(secretRef: string, value: string): void {
        this.assertRef(secretRef);
        this.assertValue(value);
        if (!this.preparedEncryptions.has(value)) {
            throw new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED');
        }
        const encrypted = this.preparedEncryptions.get(value);
        if (encrypted === undefined) {
            // A session-only replacement must not reactivate an old encrypted
            // key on the next launch, potentially against the edited endpoint.
            this.withLock(() => {
                const vault = this.readFile();
                if (Object.prototype.hasOwnProperty.call(vault.values, secretRef)) {
                    delete vault.values[secretRef];
                    this.writeFile(vault);
                }
            });
            this.unlockedValues.delete(secretRef);
            this.sessionValues.set(secretRef, value);
            this.preparedEncryptions.delete(value);
            return;
        }
        this.withLock(() => {
            const vault = this.readFile();
            vault.values[secretRef] = encrypted;
            this.writeFile(vault);
        });
        this.unlockedValues.set(secretRef, { encrypted, value });
        this.sessionValues.delete(secretRef);
        this.preparedEncryptions.delete(value);
    }

    /** Never calls safeStorage; unprepared reads fail promptly and explicitly. */
    get(secretRef: string): string | undefined {
        this.assertRef(secretRef);
        const inMemory = this.sessionValues.get(secretRef);
        if (inMemory !== undefined) return inMemory;
        const encrypted = this.readFile().values[secretRef];
        if (!encrypted) {
            this.unlockedValues.delete(secretRef);
            return undefined;
        }
        const unlocked = this.unlockedValues.get(secretRef);
        if (unlocked?.encrypted === encrypted) return unlocked.value;
        this.unlockedValues.delete(secretRef);
        throw new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED');
    }

    /** Only credentials actually exposed to a runtime need exact-value redaction. */
    cachedSecrets(): string[] {
        return [...new Set([...this.sessionValues.values(), ...[...this.unlockedValues.values()].map(entry => entry.value)])];
    }

    capture(secretRef: string): CredentialSnapshot {
        this.assertRef(secretRef);
        return { encrypted: this.readFile().values[secretRef], sessionValue: this.sessionValues.get(secretRef) };
    }

    /** Restoring ciphertext must not depend on the Keychain being unlocked. */
    restore(secretRef: string, snapshot: CredentialSnapshot): void {
        this.assertRef(secretRef);
        this.withLock(() => {
            const vault = this.readFile();
            if (snapshot.encrypted === undefined) delete vault.values[secretRef];
            else vault.values[secretRef] = snapshot.encrypted;
            this.writeFile(vault);
        });
        this.unlockedValues.delete(secretRef);
        if (snapshot.sessionValue === undefined) this.sessionValues.delete(secretRef);
        else this.sessionValues.set(secretRef, snapshot.sessionValue);
    }

    delete(secretRef: string): void {
        this.assertRef(secretRef);
        // Removing ciphertext needs no OS password manager. This also makes
        // interrupted Provider recovery and deleting a broken key nonblocking.
        this.withLock(() => {
            const vault = this.readFile();
            if (Object.prototype.hasOwnProperty.call(vault.values, secretRef)) {
                delete vault.values[secretRef];
                this.writeFile(vault);
            }
        });
        this.sessionValues.delete(secretRef);
        this.unlockedValues.delete(secretRef);
    }

    protected clearRecoveryMarker(): void {
        try { fs.unlinkSync(this.recoveryPath); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    protected assertValue(value: string): void {
        if (!value) throw new Error('API key must not be empty.');
        if (Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new Error('Secrets are limited to 16384 UTF-8 bytes.');
    }

    protected readFile(): VaultFile {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<VaultFile>;
            if (parsed.schemaVersion === 1 && parsed.values && typeof parsed.values === 'object'
                && !Array.isArray(parsed.values)
                && Object.values(parsed.values).every(value => typeof value === 'string'
                    && value.length <= 64 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value))) {
                return { schemaVersion: 1, values: { ...parsed.values } };
            }
            throw new Error('Invalid encrypted credential store.');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error('Unable to read the encrypted credential store.');
            }
        }
        return { schemaVersion: 1, values: {} };
    }

    protected writeFile(vault: VaultFile): void {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, `${JSON.stringify(vault, undefined, 2)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        try {
            fs.renameSync(temporary, this.filePath);
            fs.chmodSync(this.filePath, 0o600);
            fsyncDirectory(directory);
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch { /* already moved */ }
            throw error;
        }
    }

    protected withLock<T>(operation: () => T): T {
        const directory = path.dirname(this.lockPath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        let descriptor: number;
        try {
            descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs <= 30_000) {
                throw new Error('Another Xora Code process is updating credentials. Please retry.');
            }
            fs.unlinkSync(this.lockPath);
            descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        }
        try {
            fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
            fs.fsyncSync(descriptor);
            return operation();
        } finally {
            fs.closeSync(descriptor);
            try { fs.unlinkSync(this.lockPath); } catch { /* already removed */ }
        }
    }

    protected assertRef(secretRef: string): void {
        if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(secretRef)) {
            throw new Error('Unsafe secret reference.');
        }
    }
}

function fsyncDirectory(directory: string): void {
    try {
        const descriptor = fs.openSync(directory, 'r');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch { /* unsupported by some Windows filesystems */ }
}
