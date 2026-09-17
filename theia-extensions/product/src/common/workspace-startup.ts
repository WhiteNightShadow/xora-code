// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

export class WorkspaceStartupTimeout extends Error {
    constructor() {
        super('Workspace restoration timed out');
    }
}

/** The renderer could not observe the outcome; this does not identify a bad workspace. */
export class WorkspaceFrontendUnresponsiveTimeout extends WorkspaceStartupTimeout {}

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

/**
 * A renderer cannot receive filesystem RPC replies while a long startup task
 * owns its event loop. Do not treat those blocked turns as failed filesystem
 * work. The wall-clock ceiling still bounds repeated starvation; backend IO
 * continues to use workspaceDeadline's ordinary wall-clock timeout.
 */
export function workspaceFrontendDeadline<T>(operation: Promise<T>, milliseconds: number, maximumMilliseconds: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const started = performance.now();
        const sample = Math.min(100, milliseconds);
        let remaining = milliseconds;
        let previous = started;
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const schedule = (): void => {
            const delay = Math.min(sample, Math.max(1, remaining));
            timer = setTimeout(() => {
                if (settled) return;
                const now = performance.now();
                const elapsed = Math.max(0, now - previous);
                previous = now;
                // Give a queued reply a chance to settle after a blocked turn,
                // even if this would otherwise have been the final sample.
                if (elapsed <= delay * 2) remaining -= elapsed;
                if (remaining <= 0 || now - started >= maximumMilliseconds) {
                    settled = true;
                    reject(now - started >= maximumMilliseconds
                        ? new WorkspaceFrontendUnresponsiveTimeout() : new WorkspaceStartupTimeout());
                } else {
                    schedule();
                }
            }, delay);
        };
        schedule();
        operation.then(value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (performance.now() - started >= maximumMilliseconds) reject(new WorkspaceFrontendUnresponsiveTimeout());
            else resolve(value);
        }, error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}
