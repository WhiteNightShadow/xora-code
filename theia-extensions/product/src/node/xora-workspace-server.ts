// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FileUri } from '@theia/core/lib/node';
import URI from '@theia/core/lib/common/uri';
import * as fs from '@theia/core/shared/fs-extra';
import { injectable } from '@theia/core/shared/inversify';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { DefaultWorkspaceServer, RecentWorkspacePathsData } from '@theia/workspace/lib/node/default-workspace-server';
import { workspaceDeadline } from '../common/workspace-startup';

const WORKSPACE_FILE = /\.(?:theia-workspace|code-workspace)$/iu;

/**
 * Theia accepts any existing positional file as the last workspace. That is
 * useful for generic embedders, but it also means an Electron development
 * entrypoint can be remembered and shown later as an invalid workspace.
 * Xora only restores directories and actual workspace documents.
 */
@injectable()
export class XoraWorkspaceServer extends DefaultWorkspaceServer {
    protected readonly workspaceIoTimeout = 1500;
    protected historyVersion = 0;
    protected historyWrites: Promise<void> = Promise.resolve();

    protected override async doInit(): Promise<void> {
        // Capture the deferred: a late initial lookup must not overwrite a
        // newer empty-window or explicitly selected workspace.
        const root = this.root;
        try {
            root.resolve(await workspaceDeadline(this.getRoot(), this.workspaceIoTimeout * 2));
        } catch {
            if (root === this.root) this.historyVersion++;
            root.resolve(undefined);
        }
    }

    override async onStart(): Promise<void> {
        // Do not run Theia's startup garbage collection: it probes and deletes
        // old untitled workspaces, including documents on disconnected drives.
        // Keeping these documents is preferable to blocking backend startup.
    }

    protected override async getRoot(): Promise<string | undefined> {
        const version = this.historyVersion;
        const cliRoot = await workspaceDeadline(this.getWorkspaceURIFromCli(), this.workspaceIoTimeout);
        if (cliRoot && await this.workspaceRootStatus(cliRoot) !== 'invalid') return cliRoot;

        const data = await this.readRecentWorkspacePathsFromUserHome();
        if (!data?.recentRoots.length || data.recentRoots[0] === '') return undefined;

        const invalid = new Set<string>();
        let selected: string | undefined;
        for (const root of data.recentRoots) {
            if (!root) break;
            if (await this.workspaceRootStatus(root) === 'invalid') {
                invalid.add(root);
            } else {
                // Let the frontend report and quarantine unavailable roots.
                // Do not probe every historical network drive on each startup.
                selected = root;
                break;
            }
        }
        if (invalid.size && version === this.historyVersion) {
            await this.writeToUserHome({ recentRoots: data.recentRoots.filter(root => !invalid.has(root)) });
        }
        return selected;
    }

    override async getRecentWorkspaces(): Promise<string[]> {
        try {
            return (await this.readRecentWorkspacePathsFromUserHome())?.recentRoots.filter(Boolean) ?? [];
        } catch {
            return [];
        }
    }

    override async setMostRecentlyUsedWorkspace(rawUri: string): Promise<void> {
        const version = ++this.historyVersion;
        const uri = rawUri && new URI(rawUri).toString();
        this.root = new Deferred<string | undefined>();
        this.root.resolve(uri);
        try {
            const data = await this.readRecentWorkspacePathsFromUserHome();
            if (version === this.historyVersion) {
                await this.writeToUserHome({ recentRoots: Array.from(new Set([uri, ...(data?.recentRoots ?? [])])) });
            }
        } catch {
            // An unreadable history file must not be overwritten with a
            // truncated list. The in-memory MRU is already updated.
        }
    }

    protected override readRecentWorkspacePathsFromUserHome(): Promise<RecentWorkspacePathsData | undefined> {
        return workspaceDeadline(super.readRecentWorkspacePathsFromUserHome(), this.workspaceIoTimeout);
    }

    protected override async writeToUserHome(data: RecentWorkspacePathsData): Promise<void> {
        // Serialize actual writes, even after callers stop waiting. Otherwise
        // an old slow write can replace the more recent empty-window choice.
        this.historyWrites = this.historyWrites.then(() => super.writeToUserHome(data)).catch(() => undefined);
        await workspaceDeadline(this.historyWrites, this.workspaceIoTimeout).catch(() => undefined);
    }

    protected async workspaceRootStatus(rawUri: string): Promise<'valid' | 'invalid' | 'unavailable'> {
        try {
            const uri = new URI(rawUri);
            if (uri.scheme !== 'file') return 'valid';
            const stat = await workspaceDeadline(fs.stat(FileUri.fsPath(uri)), this.workspaceIoTimeout);
            return stat.isDirectory() || stat.isFile() && WORKSPACE_FILE.test(uri.path.base) ? 'valid' : 'invalid';
        } catch {
            // ENOENT can also mean an unmounted volume. Preserve its history.
            return 'unavailable';
        }
    }

    protected async isValidWorkspaceRoot(rawUri: string): Promise<boolean> {
        return await this.workspaceRootStatus(rawUri) === 'valid';
    }
}
