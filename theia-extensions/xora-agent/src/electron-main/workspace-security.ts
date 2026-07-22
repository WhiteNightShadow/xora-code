import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentPermissionMode } from '../common/agent-protocol';
import { normalizeWindowsFilesystemPath } from '../common/workspace-path';

interface TrustFile {
    schemaVersion: 1;
    trustedRoots: Record<string, { trustedAt: string; canonicalPath: string }>;
}

interface PermissionRule {
    id: string;
    workspaceRoot: string;
    sidecarVersion: string;
    toolName: string;
    fingerprint: string;
    createdAt: string;
    expiresAt: string;
}

interface PolicyFile {
    schemaVersion: 1;
    rules: PermissionRule[];
}

interface AgentPermissionFile {
    schemaVersion: 1;
    permissionMode: AgentPermissionMode;
    updatedAt: string;
}

export interface PermissionSubject {
    toolName: string;
    path?: string;
    command?: string;
    mcpServer?: string;
}

/** Electron-main-owned trust state. Renderer input is never authoritative. */
export class WorkspaceSecurityStore {
    protected readonly trustPath = path.join(app.getPath('userData'), 'security', 'workspace-trust.json');
    protected readonly policyPath = path.join(app.getPath('userData'), 'security', 'agent-policy.json');
    protected readonly agentPermissionPath = path.join(app.getPath('userData'), 'security', 'agent-permission-mode.json');

    /**
     * Reads the Electron-main-owned application preference. Reading from disk
     * keeps a second Xora Code process from being hidden behind stale renderer
     * state; malformed files fail closed instead of granting full access.
     */
    agentPermissionMode(): AgentPermissionMode {
        try {
            return this.readAgentPermission().permissionMode;
        } catch {
            // A damaged or temporarily unreadable preference must never turn
            // into an implicit full-access grant.
            return 'request-approval';
        }
    }

    setAgentPermissionMode(mode: AgentPermissionMode): AgentPermissionMode {
        if (mode !== 'request-approval' && mode !== 'full-access') {
            throw new Error('Unsupported Agent permission mode.');
        }
        const current = this.readAgentPermission();
        if (current.permissionMode === mode) return mode;
        this.atomicWrite(this.agentPermissionPath, {
            schemaVersion: 1,
            permissionMode: mode,
            updatedAt: new Date().toISOString()
        } satisfies AgentPermissionFile);
        return mode;
    }

    isTrusted(root: string): boolean {
        const canonical = this.canonicalRoot(root);
        return this.readTrust().trustedRoots[this.rootId(canonical)]?.canonicalPath === canonical;
    }

    trust(root: string): string {
        const canonical = this.canonicalRoot(root);
        this.synchronizeTrust([canonical], true);
        return canonical;
    }

    revoke(root: string): string {
        const canonical = this.canonicalRoot(root);
        this.synchronizeTrust([canonical], false);
        return canonical;
    }

    /** Applies one Theia workspace decision to all of its roots in one write. */
    synchronizeTrust(roots: readonly string[], trusted: boolean): string[] {
        const canonicalRoots = [...new Set(roots.map(root => trusted
            ? this.canonicalRoot(root)
            : this.canonicalRootForRevocation(root)))];
        const trust = this.readTrust();
        let changed = false;
        const trustedAt = new Date().toISOString();
        for (const canonical of canonicalRoots) {
            const id = this.rootId(canonical);
            if (trusted) {
                const previous = trust.trustedRoots[id];
                if (previous?.canonicalPath !== canonical) {
                    trust.trustedRoots[id] = { trustedAt, canonicalPath: canonical };
                    changed = true;
                }
            } else if (trust.trustedRoots[id]) {
                delete trust.trustedRoots[id];
                changed = true;
            }
        }
        if (changed) {
            this.atomicWrite(this.trustPath, trust);
        }
        return canonicalRoots;
    }

    protected canonicalRootForRevocation(root: string): string {
        if (!path.isAbsolute(root)) {
            throw new Error('Workspace root must be an absolute path.');
        }
        try {
            return this.canonicalRoot(root);
        } catch {
            // Trust revocation is fail-closed even if a workspace directory was
            // removed or became unreadable after Theia opened it.
            return path.normalize(path.resolve(root));
        }
    }

    hasPersistentPermission(root: string, sidecarVersion: string, subject: PermissionSubject): boolean {
        const canonical = this.canonicalRoot(root);
        const fingerprint = this.permissionFingerprint(subject);
        const now = Date.now();
        const file = this.readPolicy();
        const active = file.rules.filter(rule => Date.parse(rule.expiresAt) > now);
        if (active.length !== file.rules.length) {
            this.atomicWrite(this.policyPath, { schemaVersion: 1, rules: active });
        }
        return active.some(rule =>
            rule.workspaceRoot === canonical &&
            rule.sidecarVersion === sidecarVersion &&
            rule.toolName === subject.toolName &&
            rule.fingerprint === fingerprint
        );
    }

    rememberPermission(root: string, sidecarVersion: string, subject: PermissionSubject, expiresAt?: string): void {
        const canonical = this.canonicalRoot(root);
        const now = new Date();
        const requestedExpiry = expiresAt ? new Date(expiresAt) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        if (!Number.isFinite(requestedExpiry.getTime()) || requestedExpiry <= now) {
            throw new Error('The permission expiry must be in the future.');
        }
        // Avoid effectively permanent rules. Users can renew after one year.
        const maximum = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
        const effectiveExpiry = requestedExpiry > maximum ? maximum : requestedExpiry;
        const fingerprint = this.permissionFingerprint(subject);
        const file = this.readPolicy();
        file.rules = file.rules.filter(rule => !(
            rule.workspaceRoot === canonical &&
            rule.sidecarVersion === sidecarVersion &&
            rule.toolName === subject.toolName &&
            rule.fingerprint === fingerprint
        ));
        file.rules.push({
            id: crypto.randomUUID(),
            workspaceRoot: canonical,
            sidecarVersion,
            toolName: subject.toolName,
            fingerprint,
            createdAt: now.toISOString(),
            expiresAt: effectiveExpiry.toISOString()
        });
        this.atomicWrite(this.policyPath, file);
    }

    canonicalRoot(root: string): string {
        const candidate = normalizeWindowsFilesystemPath(root);
        // After Windows URI-path repair, re-check absoluteness so `/d:/foo`
        // does not slip through as a false absolute and become `D:\d:\foo`.
        if (!path.isAbsolute(candidate) || isWindowsUriPathForm(candidate)) {
            throw new Error('Workspace root must be an absolute path.');
        }
        const resolved = fs.realpathSync.native(candidate);
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            throw new Error('Workspace root must be a directory.');
        }
        return path.normalize(resolved);
    }

    protected permissionFingerprint(subject: PermissionSubject): string {
        const normalizedPath = subject.path ? path.normalize(subject.path) : undefined;
        return crypto.createHash('sha256').update(JSON.stringify({
            toolName: subject.toolName,
            path: normalizedPath,
            command: subject.command,
            mcpServer: subject.mcpServer
        })).digest('hex');
    }

    protected rootId(canonical: string): string {
        return crypto.createHash('sha256').update(canonical).digest('hex');
    }

    protected readTrust(): TrustFile {
        return this.readJson<TrustFile>(this.trustPath, { schemaVersion: 1, trustedRoots: {} }, value =>
            value.schemaVersion === 1 && value.trustedRoots !== undefined
        );
    }

    protected readPolicy(): PolicyFile {
        return this.readJson<PolicyFile>(this.policyPath, { schemaVersion: 1, rules: [] }, value =>
            value.schemaVersion === 1 && Array.isArray(value.rules)
        );
    }

    protected readAgentPermission(): AgentPermissionFile {
        return this.readJson<AgentPermissionFile>(this.agentPermissionPath, {
            schemaVersion: 1,
            permissionMode: 'request-approval',
            updatedAt: new Date(0).toISOString()
        }, value => value.schemaVersion === 1
            && (value.permissionMode === 'request-approval' || value.permissionMode === 'full-access')
            && typeof value.updatedAt === 'string'
        );
    }

    protected readJson<T>(target: string, fallback: T, validate: (value: T) => boolean): T {
        try {
            const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as T;
            if (!validate(parsed)) {
                throw new Error(`Invalid security state: ${target}`);
            }
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return fallback;
            }
            throw error;
        }
    }

    protected atomicWrite(target: string, value: unknown): void {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o600);
    }
}

/** True for residual `/d:/…` forms that Node still treats as absolute on win32. */
function isWindowsUriPathForm(value: string): boolean {
    if (process.platform !== 'win32') return false;
    return /^[/\\][A-Za-z]:[/\\]/.test(value);
}
