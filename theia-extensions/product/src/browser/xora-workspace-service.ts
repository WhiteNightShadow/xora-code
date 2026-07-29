// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import URI from '@theia/core/lib/common/uri';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

/**
 * Development and automation launchers can accidentally leave their JavaScript
 * bootstrap file in the window hash. Theia reports that ordinary file as an
 * invalid workspace before the backend workspace sanitizer can run. Treat the
 * file as an explicit empty-window launch and keep the notification surface
 * quiet; actual workspace documents and directories still follow Theia's
 * normal path.
 */
@injectable()
export class XoraWorkspaceService extends WorkspaceService {
    protected override async doGetDefaultWorkspaceUri(): Promise<string | undefined> {
        const candidate = this.workspaceUriFromWindowHash();
        if (candidate) {
            let stat: FileStat | undefined;
            try {
                stat = await this.fileService.resolve(candidate);
            } catch {
                // Missing paths retain Theia's normal diagnostic and recovery.
            }
            if (stat?.isFile && !this.isWorkspaceFile(stat)) {
                window.history.replaceState(undefined, document.title, `${window.location.pathname}${window.location.search}`);
                return undefined;
            }
        }
        return super.doGetDefaultWorkspaceUri();
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
