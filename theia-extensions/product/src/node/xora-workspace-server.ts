// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FileUri } from '@theia/core/lib/node';
import URI from '@theia/core/lib/common/uri';
import * as fs from '@theia/core/shared/fs-extra';
import { injectable } from '@theia/core/shared/inversify';
import { DefaultWorkspaceServer, RecentWorkspacePathsData } from '@theia/workspace/lib/node/default-workspace-server';

const WORKSPACE_FILE = /\.(?:theia-workspace|code-workspace)$/iu;

/**
 * Theia accepts any existing positional file as the last workspace. That is
 * useful for generic embedders, but it also means an Electron development
 * entrypoint can be remembered and shown later as an invalid workspace.
 * Xora only restores directories and actual workspace documents.
 */
@injectable()
export class XoraWorkspaceServer extends DefaultWorkspaceServer {
    protected override async getRoot(): Promise<string | undefined> {
        const cliRoot = await this.getWorkspaceURIFromCli();
        if (cliRoot && await this.isValidWorkspaceRoot(cliRoot)) return cliRoot;

        const data = await this.readRecentWorkspacePathsFromUserHome();
        if (!data?.recentRoots.length || data.recentRoots[0] === '') return undefined;

        const recentRoots: string[] = [];
        for (const root of data.recentRoots) {
            if (root && await this.isValidWorkspaceRoot(root)) recentRoots.push(root);
        }
        if (recentRoots.length !== data.recentRoots.filter(Boolean).length) {
            await this.writeToUserHome({ recentRoots } satisfies RecentWorkspacePathsData);
        }
        return recentRoots[0];
    }

    protected async isValidWorkspaceRoot(rawUri: string): Promise<boolean> {
        try {
            const uri = new URI(rawUri);
            if (uri.scheme !== 'file') return this.workspaceStillExist(rawUri);
            const stat = await fs.stat(FileUri.fsPath(uri));
            return stat.isDirectory() || stat.isFile() && WORKSPACE_FILE.test(uri.path.base);
        } catch {
            return false;
        }
    }
}
