import { app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface VaultFile {
    schemaVersion: 1;
    values: Record<string, string>;
}

export class SecretVault {
    protected readonly sessionValues = new Map<string, string>();
    protected readonly filePath = path.join(app.getPath('userData'), 'security', 'secrets.json');
    protected readonly lockPath = path.join(app.getPath('userData'), 'security', '.secrets.lock');

    isPersistentStorageAvailable(): boolean {
        if (!safeStorage.isEncryptionAvailable()) {
            return false;
        }
        if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
            const backend = safeStorage.getSelectedStorageBackend();
            return backend !== 'basic_text' && backend !== 'unknown';
        }
        return true;
    }

    set(secretRef: string, value: string): void {
        this.assertRef(secretRef);
        if (!value) {
            throw new Error('API key must not be empty.');
        }
        if (Buffer.byteLength(value, 'utf8') > 16 * 1024) {
            throw new Error('Secrets are limited to 16384 UTF-8 bytes.');
        }
        if (!this.isPersistentStorageAvailable()) {
            this.sessionValues.set(secretRef, value);
            return;
        }
        this.withLock(() => {
            const vault = this.readFile();
            vault.values[secretRef] = safeStorage.encryptString(value).toString('base64');
            this.writeFile(vault);
        });
        this.sessionValues.delete(secretRef);
    }

    get(secretRef: string): string | undefined {
        this.assertRef(secretRef);
        const inMemory = this.sessionValues.get(secretRef);
        if (inMemory !== undefined) {
            return inMemory;
        }
        if (!this.isPersistentStorageAvailable()) {
            return undefined;
        }
        const encrypted = this.readFile().values[secretRef];
        if (!encrypted) {
            return undefined;
        }
        try {
            return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        } catch {
            return undefined;
        }
    }

    delete(secretRef: string): void {
        this.assertRef(secretRef);
        this.sessionValues.delete(secretRef);
        if (!this.isPersistentStorageAvailable()) {
            return;
        }
        this.withLock(() => {
            const vault = this.readFile();
            if (delete vault.values[secretRef]) {
                this.writeFile(vault);
            }
        });
    }

    protected readFile(): VaultFile {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<VaultFile>;
            if (parsed.schemaVersion === 1 && parsed.values && typeof parsed.values === 'object') {
                return { schemaVersion: 1, values: { ...parsed.values } };
            }
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
                throw new Error('Another WhiteNight Code process is updating credentials. Please retry.');
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
