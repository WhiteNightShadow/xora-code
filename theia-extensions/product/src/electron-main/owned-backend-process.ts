// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from 'child_process';

export interface BackendShutdownResult {
    forced: boolean;
    exited: boolean;
}

/** Lifecycle of the actual backend fork owned by this Electron main process. */
export class OwnedBackendProcess {
    protected readonly pid: number | undefined;
    protected stopping: Promise<BackendShutdownResult> | undefined;

    constructor(protected readonly child: ChildProcess, protected readonly detached: boolean) {
        this.pid = child.pid;
    }

    isRunning(): boolean {
        return this.pid !== undefined && Number.isInteger(this.pid) && this.pid > 1
            && this.pid !== process.pid && this.child.pid === this.pid
            && this.child.exitCode === null && this.child.signalCode === null;
    }

    stop(graceMilliseconds = 11_000, forceMilliseconds = 1000): Promise<BackendShutdownResult> {
        // Pinned Theia grants 5s each to contribution teardown and container
        // unbinding. Preserve both budgets plus a margin before escalation.
        // Defer work until the shared promise is installed: repeated quit
        // requests must never start a second signal/wait sequence.
        return this.stopping ??= Promise.resolve().then(() => this.stopOnce(graceMilliseconds, forceMilliseconds));
    }

    protected async stopOnce(graceMilliseconds: number, forceMilliseconds: number): Promise<BackendShutdownResult> {
        if (!this.isRunning()) return { forced: false, exited: true };
        // Let backend contributions finish normally before touching descendants.
        try { this.child.kill('SIGTERM'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        if (await this.waitForExit(graceMilliseconds)) return { forced: false, exited: true };
        const forced = this.forceKill();
        return { forced, exited: await this.waitForExit(forceMilliseconds) };
    }

    forceKill(): boolean {
        if (!this.isRunning()) return false;
        try {
            if (this.detached && process.platform !== 'win32') {
                this.killDetachedGroup();
                return true;
            } else {
                return this.child.kill('SIGKILL');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return false;
        }
    }

    protected killDetachedGroup(): void {
        // The group belongs to a fresh detached fork, never an IPC-supplied PID.
        // A child which has already exited is excluded to avoid PID reuse.
        process.kill(-this.pid!, 'SIGKILL');
    }

    protected waitForExit(milliseconds: number): Promise<boolean> {
        if (!this.isRunning()) return Promise.resolve(true);
        return new Promise(resolve => {
            const finish = (): void => {
                clearTimeout(timer);
                this.child.removeListener('exit', finish);
                resolve(!this.isRunning());
            };
            // Wait for process exit, not stdio close: a blocked descendant can
            // retain inherited log pipes after Electron itself has exited.
            this.child.once('exit', finish);
            const timer = setTimeout(finish, milliseconds);
            if (!this.isRunning()) finish();
        });
    }
}
