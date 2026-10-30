import path from 'node:path';

/** Layout of the data directory owned by the host (02 §5). The bootstrap owns `app/` and `electron/`. */
export interface HostPaths {
    readonly root: string;
    readonly database: string;
    readonly threadsDir: string;
    readonly backupsDir: string;
    readonly promptsDir: string;
    readonly projectsDir: string;
    readonly checkpointsDir: string;
    readonly worktreesDir: string;
    readonly enginesDir: string;
    readonly downloadsDir: string;
    readonly extensionsDir: string;
    readonly orgsDir: string;
    readonly logsDir: string;
}

export function hostPaths(root: string): HostPaths {
    const data = path.join(root, 'data');
    return {
        root,
        database: path.join(data, 'xora.db'),
        threadsDir: path.join(data, 'threads'),
        backupsDir: path.join(data, 'backups'),
        promptsDir: path.join(root, 'prompts'),
        projectsDir: path.join(root, 'projects'),
        checkpointsDir: path.join(root, 'checkpoints'),
        worktreesDir: path.join(root, 'worktrees'),
        enginesDir: path.join(root, 'engines'),
        downloadsDir: path.join(root, 'app', 'downloads'),
        extensionsDir: path.join(root, 'extensions'),
        orgsDir: path.join(root, 'orgs'),
        logsDir: path.join(root, 'logs'),
    };
}
