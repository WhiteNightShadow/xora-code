// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import URI from '@theia/core/lib/common/uri';
import { DEFAULT_WINDOW_HASH } from '@theia/core/lib/common/window';
import { isWindows } from '@theia/core/lib/common/os';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { injectable } from '@theia/core/shared/inversify';
import { WorkspaceData, WorkspaceInput, WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { parse, ParseError, stripComments } from 'jsonc-parser';
import { workspaceDeadline, workspaceFrontendDeadline, WorkspaceFrontendUnresponsiveTimeout } from '../common/workspace-startup';
import { readWorkspaceRecoveryState, writeWorkspaceRecoveryState } from '../common/workspace-recovery-key';

interface PreparedWorkspace {
    stat?: FileStat;
    roots: FileStat[];
    remote?: boolean;
}

/** Restore local workspaces without making frontend readiness depend on mounted drives. */
@injectable()
export class XoraWorkspaceService extends WorkspaceService {
    protected readonly workspaceStartupTimeout = 8000;
    protected readonly workspaceStartupMaximumWait = 120000;
    protected startupEpoch = 0;
    protected startupFinished = false;

    protected override async doInit(): Promise<void> {
        const epoch = ++this.startupEpoch;
        let expired = false;
        let candidate: string | undefined;
        let recovery = false;
        let fileIoStarted = false;
        let quarantined = false;
        let rendererUnresponsive = false;
        let prepared: PreparedWorkspace = { roots: [] };
        const current = (): boolean => !expired && epoch === this.startupEpoch;
        try {
            await workspaceFrontendDeadline((async () => {
                candidate = await this.doGetDefaultWorkspaceUri();
                if (!current() || !candidate) return;
                // Remote open handlers can reload the window and have no
                // cancellation contract; retain Theia's existing semantics.
                if (new URI(candidate).scheme !== 'file') {
                    prepared = { roots: [], remote: true };
                    return;
                }
                quarantined = !!this.recoveryState(candidate);
                if (quarantined) throw new Error('Previous workspace restoration did not complete');
                await this.waitForLocalFileSystemProvider();
            })(), this.workspaceStartupTimeout, this.workspaceStartupMaximumWait);
            if (current() && candidate && !prepared.remote) {
                // A slow provider/bootstrap handshake is not evidence of a bad
                // folder. Persist recovery state only when file IO can start.
                const workspaceUri = candidate;
                const startFileIo = (): void => {
                    if (!fileIoStarted) {
                        fileIoStarted = true;
                        this.setRecoveryState(workspaceUri, 'pending');
                    }
                };
                prepared = await workspaceFrontendDeadline(this.prepareWorkspace(new URI(workspaceUri), current, startFileIo),
                    this.workspaceStartupTimeout, this.workspaceStartupMaximumWait);
            }
        } catch (error) {
            expired = true;
            recovery = true;
            rendererUnresponsive = error instanceof WorkspaceFrontendUnresponsiveTimeout;
        }
        if (epoch !== this.startupEpoch) {
            this.finishStartup();
            return;
        }
        if (!recovery && prepared.remote) {
            await super.doInit();
            return;
        }
        if (recovery && candidate && fileIoStarted) {
            this.setRecoveryState(candidate, rendererUnresponsive ? undefined : 'failed');
        }
        const workspaceFailed = quarantined || (fileIoStarted && !rendererUnresponsive);

        // All file reads above are side-effect free. Only the winning result
        // reaches this synchronous commit; late reads cannot reopen a workspace
        // or replace roots after recovery or a manual workspace selection.
        this.applyPreparedWorkspace(prepared, !recovery || workspaceFailed);
        if (!recovery && candidate) this.setRecoveryState(candidate, undefined);
        this.finishStartup();
        if (recovery) {
            void this.messageService.warn(workspaceFailed
                ? '工作区恢复未完成，已打开空窗口，历史记录已保留。请连接网络盘或检查工作区文件，再通过“文件 → 打开最近的工作区”重新打开；也可以打开其他文件夹。'
                : '项目初始化暂未完成，已打开空窗口，最近使用记录已保留。请稍后通过“文件 → 打开最近的工作区”重新打开。');
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

    protected async prepareWorkspace(uri: URI, current: () => boolean = () => true,
        startFileIo: () => void = () => undefined): Promise<PreparedWorkspace> {
        if (!current()) return { roots: [] };
        const stat = await this.workspaceStartupStat(uri, current, startFileIo);
        if (!current()) return { roots: [] };
        if (stat?.isFile && !this.isWorkspaceFile(stat)) {
            // Ordinary launcher scripts are not workspace documents.
            return { roots: [] };
        }
        if (stat.isDirectory) return { stat, roots: [stat] };
        if (!this.isWorkspaceFile(stat)) throw new Error('Invalid workspace type');
        const content = await this.fileService.read(uri);
        if (!current()) return { roots: [] };
        const errors: ParseError[] = [];
        const data = parse(stripComments(content.value), errors, { allowTrailingComma: true });
        if (errors.length || !WorkspaceData.is(data)) throw new Error('Invalid workspace document');
        const absolute = WorkspaceData.transformToAbsolute(data, stat);
        const roots = await Promise.all(absolute.folders.map(async folder => {
            const root = await this.workspaceStartupStat(new URI(folder.path), current);
            if (!root.isDirectory) throw new Error('Workspace folder is unavailable');
            return root;
        }));
        return { stat, roots };
    }

    protected async workspaceStartupStat(uri: URI, current: () => boolean = () => true,
        startFileIo: () => void = () => undefined): Promise<FileStat> {
        const provider = await this.fileService.activateProvider(uri.scheme);
        if (!current()) throw new Error('Workspace restoration superseded');
        // FileService.resolve also enumerates every immediate child of a
        // directory. Workspace readiness only needs metadata; Explorer can
        // load directory contents after the workbench becomes usable.
        startFileIo();
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
            await workspaceFrontendDeadline(new Promise<void>(resolve => {
                const registration = this.fileService.onDidChangeFileSystemProviderRegistrations(event => {
                    if (event.added && event.scheme === 'file') resolve();
                });
                dispose = () => registration.dispose();
                if (this.fileService.hasProvider('file')) resolve();
            }), this.workspaceStartupTimeout, this.workspaceStartupMaximumWait);
        } finally {
            dispose();
        }
    }

    protected applyPreparedWorkspace(prepared: PreparedWorkspace, persistHistory = true): void {
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
        if (persistHistory && !this.isRemoteSession()) {
            void workspaceDeadline(this.server.setMostRecentlyUsedWorkspace(prepared.stat?.resource.toString() ?? ''), 1500)
                .catch(() => undefined);
        }
    }

    protected recoveryState(uri: string): string | null {
        try {
            return readWorkspaceRecoveryState(window.localStorage, uri, isWindows);
        } catch {
            return null;
        }
    }

    protected setRecoveryState(uri: string, state: 'pending' | 'failed' | undefined): void {
        try {
            writeWorkspaceRecoveryState(window.localStorage, uri, isWindows, state);
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
        return workspaceFrontendDeadline((async () => {
            if (uri && new URI(uri.toString()).scheme === 'file') await this.waitForLocalFileSystemProvider();
            return super.toFileStat(uri);
        })(), this.workspaceStartupTimeout, this.workspaceStartupMaximumWait).catch(() => undefined);
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
