// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import URI from '@theia/core/lib/common/uri';
import { DEFAULT_WINDOW_HASH } from '@theia/core/lib/common/window';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { injectable } from '@theia/core/shared/inversify';
import { WorkspaceData, WorkspaceInput, WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { parse, ParseError, stripComments } from 'jsonc-parser';
import { workspaceDeadline } from '../common/workspace-startup';

interface PreparedWorkspace {
    stat?: FileStat;
    roots: FileStat[];
    remote?: boolean;
}

const RECOVERY_KEY = 'xora.workspace-recovery:';

/** Restore local workspaces without making frontend readiness depend on mounted drives. */
@injectable()
export class XoraWorkspaceService extends WorkspaceService {
    protected readonly workspaceStartupTimeout = 8000;
    protected startupEpoch = 0;
    protected startupFinished = false;

    protected override async doInit(): Promise<void> {
        const epoch = ++this.startupEpoch;
        let expired = false;
        let candidate: string | undefined;
        let recovery = false;
        let prepared: PreparedWorkspace = { roots: [] };
        try {
            prepared = await workspaceDeadline((async () => {
                const uri = await this.doGetDefaultWorkspaceUri();
                if (expired || epoch !== this.startupEpoch) return { roots: [] };
                candidate = uri;
                if (!uri) return { roots: [] };
                // Remote open handlers can reload the window and have no
                // cancellation contract; retain Theia's existing semantics.
                if (new URI(uri).scheme !== 'file') return { roots: [], remote: true };
                if (this.recoveryState(uri)) throw new Error('Previous workspace restoration did not complete');
                this.setRecoveryState(uri, 'pending');
                return this.prepareWorkspace(new URI(uri));
            })(), this.workspaceStartupTimeout);
        } catch {
            expired = true;
            recovery = true;
        }
        if (epoch !== this.startupEpoch) {
            this.finishStartup();
            return;
        }
        if (prepared.remote) {
            await super.doInit();
            return;
        }
        if (recovery && candidate) this.setRecoveryState(candidate, 'failed');

        // All file reads above are side-effect free. Only the winning result
        // reaches this synchronous commit; late reads cannot reopen a workspace
        // or replace roots after recovery or a manual workspace selection.
        this.applyPreparedWorkspace(prepared);
        if (!recovery && candidate) this.setRecoveryState(candidate, undefined);
        this.finishStartup();
        if (recovery) {
            void this.messageService.warn('工作区恢复未完成，已打开空窗口，历史记录已保留。请连接网络盘或检查工作区文件，再通过“文件 → 打开最近的工作区”重新打开；也可以打开其他文件夹。');
        }
    }

    protected finishStartup(): void {
        if (this.startupFinished) return;
        this.startupFinished = true;
        this.fileService.onDidFilesChange(event => {
            if (this._workspace?.isFile && event.contains(this._workspace.resource)) {
                void this.updateWorkspace();
            }
        });
        this.fsPreferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'files.watcherExclude') void this.refreshRootWatchers();
        });
        this.deferredRoots.resolve(this._roots);
        this._ready.resolve();
    }

    protected async prepareWorkspace(uri: URI): Promise<PreparedWorkspace> {
        await this.waitForLocalFileSystemProvider();
        const stat = await this.workspaceStartupStat(uri);
        if (stat?.isFile && !this.isWorkspaceFile(stat)) {
            // Ordinary launcher scripts are not workspace documents.
            return { roots: [] };
        }
        if (stat.isDirectory) return { stat, roots: [stat] };
        if (!this.isWorkspaceFile(stat)) throw new Error('Invalid workspace type');
        const content = await this.fileService.read(uri);
        const errors: ParseError[] = [];
        const data = parse(stripComments(content.value), errors, { allowTrailingComma: true });
        if (errors.length || !WorkspaceData.is(data)) throw new Error('Invalid workspace document');
        const absolute = WorkspaceData.transformToAbsolute(data, stat);
        const roots = await Promise.all(absolute.folders.map(async folder => {
            const root = await this.workspaceStartupStat(new URI(folder.path));
            if (!root.isDirectory) throw new Error('Workspace folder is unavailable');
            return root;
        }));
        return { stat, roots };
    }

    protected async workspaceStartupStat(uri: URI): Promise<FileStat> {
        const provider = await this.fileService.activateProvider(uri.scheme);
        // FileService.resolve also enumerates every immediate child of a
        // directory. Workspace readiness only needs metadata; Explorer can
        // load directory contents after the workbench becomes usable.
        return FileStat.fromStat(uri, await provider.stat(uri));
    }

    protected async waitForLocalFileSystemProvider(): Promise<void> {
        if (this.fileService.hasProvider('file')) return;
        let dispose: () => void = () => undefined;
        try {
            // Resolving before the built-in provider registers triggers Theia's
            // extension activation path. Plugin activation itself waits for
            // workspace readiness, creating a cycle even for healthy folders.
            // Registration is driven by the backend capability handshake and
            // does not depend on extension or workspace initialization.
            await workspaceDeadline(new Promise<void>(resolve => {
                const registration = this.fileService.onDidChangeFileSystemProviderRegistrations(event => {
                    if (event.added && event.scheme === 'file') resolve();
                });
                dispose = () => registration.dispose();
                if (this.fileService.hasProvider('file')) resolve();
            }), this.workspaceStartupTimeout);
        } finally {
            dispose();
        }
    }

    protected applyPreparedWorkspace(prepared: PreparedWorkspace): void {
        this.toDisposeOnWorkspace.dispose();
        this._workspace = prepared.stat;
        if (prepared.stat?.isFile) {
            this.toDisposeOnWorkspace.push(this.fileService.watch(prepared.stat.resource));
            this.onWorkspaceLocationChangedEmitter.fire(prepared.stat);
        }
        if (prepared.stat) {
            this.setURLFragment(this.getWorkspacePath(prepared.stat.resource));
        } else {
            window.history.replaceState(undefined, document.title, `${window.location.pathname}${window.location.search}`);
        }
        this.updateTitle();
        this._roots = prepared.roots;
        this.deferredRoots.resolve(prepared.roots);
        this.onWorkspaceChangeEmitter.fire(prepared.roots);
        // File watchers and history persistence must not hold ready/roots open.
        void this.watchRoots().catch(() => undefined);
        if (!this.isRemoteSession()) {
            void workspaceDeadline(this.server.setMostRecentlyUsedWorkspace(prepared.stat?.resource.toString() ?? ''), 1500)
                .catch(() => undefined);
        }
    }

    protected recoveryState(uri: string): string | null {
        try {
            return window.localStorage.getItem(RECOVERY_KEY + uri);
        } catch {
            return null;
        }
    }

    protected setRecoveryState(uri: string, state: 'pending' | 'failed' | undefined): void {
        try {
            if (state) window.localStorage.setItem(RECOVERY_KEY + uri, state);
            else window.localStorage.removeItem(RECOVERY_KEY + uri);
        } catch {
            // Restricted browser storage must not prevent startup recovery.
        }
    }

    override async openWorkspace(uri: URI, options?: WorkspaceInput): Promise<void> {
        ++this.startupEpoch;
        this.setRecoveryState(uri.toString(), undefined);
        this.finishStartup();
        return super.openWorkspace(uri, options);
    }

    protected override async setWorkspace(stat: FileStat | undefined): Promise<void> {
        ++this.startupEpoch;
        return super.setWorkspace(stat);
    }

    protected override async toFileStat(uri: URI | string | undefined): Promise<FileStat | undefined> {
        return workspaceDeadline((async () => {
            if (uri && new URI(uri.toString()).scheme === 'file') await this.waitForLocalFileSystemProvider();
            return super.toFileStat(uri);
        })(), this.workspaceStartupTimeout).catch(() => undefined);
    }

    protected override async doGetDefaultWorkspaceUri(): Promise<string | undefined> {
        if (window.location.hash === `#${DEFAULT_WINDOW_HASH}`) {
            window.history.replaceState(undefined, document.title, `${window.location.pathname}${window.location.search}`);
            return undefined;
        }
        if (window.location.hash.length > 1) {
            const candidate = this.workspaceUriFromWindowHash();
            if (!candidate) throw new Error('Invalid workspace location');
            return candidate.toString();
        }
        return this.server.getMostRecentlyUsedWorkspace();
    }

    protected workspaceUriFromWindowHash(): URI | undefined {
        if (window.location.hash.length <= 1) return undefined;
        try {
            const path = decodeURI(window.location.hash.substring(1));
            if (path.startsWith('//')) {
                const unc = path.slice(2);
                const firstSlash = unc.indexOf('/');
                const authority = firstSlash >= 0 ? unc.slice(0, firstSlash) : unc;
                const uncPath = firstSlash >= 0 ? unc.slice(firstSlash) : '/';
                return new URI().withPath(uncPath).withAuthority(authority).withScheme('file');
            }
            return new URI().withPath(path).withScheme('file');
        } catch {
            return undefined;
        }
    }
}
