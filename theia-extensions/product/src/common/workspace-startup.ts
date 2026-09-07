// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

export class WorkspaceStartupTimeout extends Error {
    constructor() {
        super('Workspace restoration timed out');
    }
}

/** Stops waiting without canceling IO; callers must isolate or serialize side effects. */
export function workspaceDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new WorkspaceStartupTimeout()), milliseconds);
        operation.then(value => {
            clearTimeout(timer);
            resolve(value);
        }, error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
