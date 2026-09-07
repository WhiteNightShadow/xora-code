import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';

interface WindowsJobLaunch {
    binary: string;
    args: string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    guardianScript: string;
}

export function windowsProcessJobScriptPath(options: {
    packaged: boolean;
    resourcesPath: string;
    applicationRoot?: string;
    entry?: string;
}): string {
    if (options.packaged) return path.join(options.resourcesPath, 'app.asar.unpacked', 'scripts', 'windows-process-job.ps1');
    if (options.entry) return path.join(path.dirname(options.entry), 'windows-process-job.ps1');
    return options.applicationRoot ? path.join(options.applicationRoot, 'scripts', 'windows-process-job.ps1')
        : path.resolve(__dirname, '../../../../applications/electron/scripts/windows-process-job.ps1');
}

/** A private control channel is separate from the guardian's raw ACP stdio. */
export class WindowsProcessJob {
    readonly process: ChildProcessWithoutNullStreams;
    protected readonly server: net.Server;
    protected readonly token = crypto.randomBytes(32).toString('hex');
    protected socket: net.Socket | undefined;
    protected authenticated = false;
    protected launchSent = false;
    protected stopRequested = false;
    protected terminationConfirmed = false;
    protected errorReported = false;
    protected startupTimer: NodeJS.Timeout | undefined;
    protected stopTimer: NodeJS.Timeout | undefined;

    constructor(protected readonly launch: WindowsJobLaunch) {
        const pipe = `\\\\.\\pipe\\xora-grok-${crypto.randomUUID()}`;
        this.server = net.createServer(socket => this.acceptConnection(socket));
        this.server.on('error', () => this.fail());
        // The random pipe name plus a second independent secret authenticate
        // termination acknowledgements; no process can release a prompt claim
        // merely by guessing or discovering the local pipe endpoint.
        this.server.listen(pipe);
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        try {
            this.process = spawn(powershell, [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launch.guardianScript
            ], {
                cwd: launch.cwd,
                env: { ...launch.environment, XORA_WINDOWS_JOB_PIPE: pipe, XORA_WINDOWS_JOB_TOKEN: this.token },
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (error) {
            this.server.close();
            throw error;
        }
        this.process.once('error', () => {
            if (this.process.pid === undefined) {
                this.terminationConfirmed = true;
                this.closeControl();
            }
        });
        this.process.once('exit', () => this.guardianExited());
        this.startupTimer = setTimeout(() => {
            this.fail();
            if (!this.launchSent) {
                this.abort();
            }
        }, 15_000);
    }

    get running(): boolean {
        return !this.terminationConfirmed;
    }

    stop(): void {
        this.stopRequested = true;
        if (this.authenticated) this.send({ type: 'stop' });
        if (!this.terminationConfirmed && !this.stopTimer
            && this.process.exitCode === null && this.process.signalCode == null) {
            // A native CreateProcess call can stall on a disconnected volume.
            // Job assignment is atomic, so killing the guardian also closes
            // its Job safely. Missing terminal proof still retains fences.
            this.stopTimer = setTimeout(() => this.abort(), 6_000);
            this.stopTimer.unref();
        }
    }

    abort(): void {
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = undefined;
        // Use the owned live ChildProcess handle, never an exited/recycled PID.
        if (this.process.exitCode === null && this.process.signalCode == null) {
            try { this.process.kill('SIGKILL'); } catch { /* still unconfirmed */ }
        }
    }

    /** Losing this channel makes the guardian terminate its owned Job. */
    disconnect(): void {
        this.stopRequested = true;
        this.closeControl();
    }

    protected guardianExited(): void {
        if (!this.launchSent) this.terminationConfirmed = true;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = undefined;
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = undefined;
        // A final authenticated packet can still be buffered after exit.
        // Keep the socket until EOF and retain authority if none arrived.
        if (this.terminationConfirmed) this.closeControl();
    }

    protected acceptConnection(socket: net.Socket): void {
        if (this.socket || this.terminationConfirmed) {
            socket.destroy();
            return;
        }
        this.socket = socket;
        socket.setEncoding('utf8');
        let pending = '';
        const authenticationTimer = setTimeout(() => { if (!this.authenticated) socket.destroy(); }, 1_000);
        socket.on('data', chunk => {
            pending += chunk;
            if (Buffer.byteLength(pending, 'utf8') > 16 * 1024) {
                socket.destroy();
                return;
            }
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                let message: Record<string, unknown>;
                try { message = JSON.parse(line); } catch { socket.destroy(); return; }
                if (!message || typeof message !== 'object') { socket.destroy(); return; }
                if (!this.authenticated) {
                    if (message.type !== 'hello' || message.token !== this.token) { socket.destroy(); return; }
                    this.authenticated = true;
                    clearTimeout(authenticationTimer);
                    if (this.stopRequested) this.send({ type: 'stop' });
                    else {
                        this.launchSent = true;
                        this.send({ type: 'launch', binary: this.launch.binary, args: this.launch.args, cwd: this.launch.cwd });
                    }
                } else if (message.type === 'started') {
                    if (this.startupTimer) clearTimeout(this.startupTimer);
                    this.startupTimer = undefined;
                } else if (message.type === 'terminated') {
                    // Only the fixed guardian can issue this packet, after it
                    // queried ActiveProcesses == 0 for this launch's Job.
                    if (!Number.isInteger(message.exitCode)
                        || !['exit', 'stop', 'disconnect', 'error'].includes(String(message.reason))) {
                        this.fail();
                        return;
                    }
                    this.terminationConfirmed = true;
                    this.closeControl();
                    return;
                } else if (message.type === 'error') {
                    this.fail();
                } else {
                    this.fail();
                }
            }
        });
        socket.on('error', () => { if (this.authenticated && !this.terminationConfirmed) this.fail(); });
        socket.on('close', () => {
            clearTimeout(authenticationTimer);
            if (this.socket === socket) this.socket = undefined;
            if (this.authenticated) {
                this.server.close();
                if (!this.terminationConfirmed) this.fail();
            }
        });
    }

    protected send(message: Record<string, unknown>): void {
        try { this.socket?.write(`${JSON.stringify(message)}\n`, error => { if (error) this.fail(); }); }
        catch { this.fail(); }
    }

    protected fail(): void {
        if (this.terminationConfirmed || this.errorReported) return;
        this.errorReported = true;
        this.stop();
        const error = new Error('WINDOWS_PROCESS_JOB_FAILED: Grok process isolation could not be established or confirmed.');
        // Preserve the normal host error path and its prompt termination
        // fences. Never return native paths, control tokens or diagnostics.
        this.process?.emit('error', error);
    }

    protected closeControl(): void {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = undefined;
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = undefined;
        this.socket?.destroy();
        this.socket = undefined;
        this.server.close();
    }
}
