import { existsSync, type FSWatcher, readdir, stat, watch } from 'node:fs';
import path from 'node:path';

/**
 * Recursive directory watching for file triggers (06 §12). macOS (FSEvents) and Windows watch a whole tree
 * natively. On Linux Node's recursive mode walks the tree synchronously and watches every file, `node_modules`
 * included, so there each directory gets a watch of its own instead and the skipped directories are never entered.
 */

/** Directories that change all the time and never start a workflow: neither watched nor reported. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** Directories one walking watcher holds at most; deeper changes then go unnoticed (with a warning). */
export const MAX_WATCHED_DIRS = 10_000;

export interface TreeWatcher {
    close(): void;
}

/** Watches `root`; `onChange` gets each changed path relative to it, `/`-separated. */
export type WatchTree = (
    root: string,
    onChange: (relativePath: string) => void,
    onError: (error: Error) => void,
) => TreeWatcher;

/** Whether a relative path lies in a skipped directory. */
export function inSkippedDir(relativePath: string): boolean {
    return relativePath.split('/').some((segment) => SKIPPED_DIRS.has(segment));
}

const posix = (name: string) => name.replaceAll('\\', '/');

/**
 * Whether an event names the watched directory itself: FSEvents and inotify report a change of the directory (its
 * permissions, say) under the directory's own name. A child of that name is told apart by existing.
 */
function aboutItself(dir: string, name: string): boolean {
    return name === path.basename(dir) && !existsSync(path.join(dir, name));
}

/** One native recursive watch over the tree. */
export const nativeTreeWatch: WatchTree = (root, onChange, onError) => {
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
        const relative = name ? posix(name) : '';
        if (relative !== '' && !inSkippedDir(relative) && !aboutItself(root, relative)) {
            onChange(relative);
        }
    });
    watcher.on('error', onError);
    return { close: () => watcher.close() };
};

/**
 * A watch per directory. A directory that appears is watched too and the files already in it are reported (they
 * were written before its watch existed); one that disappears takes its watches along.
 */
export function walkingTreeWatch(maxDirectories = MAX_WATCHED_DIRS): WatchTree {
    return (root, onChange, onError) => {
        const watchers = new Map<string, FSWatcher>();
        let closed = false;
        let full = false;
        const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);
        const drop = (dir: string) => {
            for (const [key, watcher] of watchers) {
                if (key === dir || key.startsWith(`${dir}/`)) {
                    watcher.close();
                    watchers.delete(key);
                }
            }
        };
        const add = (dir: string, report: boolean): void => {
            if (closed || watchers.has(dir)) {
                return;
            }
            if (watchers.size >= maxDirectories) {
                if (!full) {
                    full = true;
                    onError(
                        new Error(`more than ${maxDirectories} directories under ${root}; deeper changes are not seen`),
                    );
                }
                return;
            }
            let watcher: FSWatcher;
            const absolute = path.join(root, dir);
            try {
                watcher = watch(absolute, { persistent: false }, (event, name) => {
                    // News about the directory itself (its removal, its permissions) is the parent watch's.
                    if (!name || closed || aboutItself(absolute, name)) {
                        return;
                    }
                    const relative = join(dir, posix(name));
                    if (inSkippedDir(relative)) {
                        return;
                    }
                    onChange(relative);
                    if (event === 'rename') {
                        stat(path.join(root, relative), (error, stats) => {
                            if (closed) {
                                return;
                            }
                            // A directory that appeared, possibly in place of one removed a moment ago whose
                            // watch is dead by now: watch it afresh.
                            drop(relative);
                            if (!error && stats.isDirectory()) {
                                add(relative, true);
                            }
                        });
                    }
                });
            } catch (error) {
                // Gone before it could be watched; the root itself has to exist.
                if (dir === '') {
                    throw error;
                }
                return;
            }
            // Removing a watched directory ends its watch with an error on some systems.
            watcher.on('error', () => drop(dir));
            watchers.set(dir, watcher);
            readdir(absolute, { withFileTypes: true }, (error, entries) => {
                if (error || closed) {
                    return;
                }
                for (const entry of entries) {
                    if (SKIPPED_DIRS.has(entry.name)) {
                        continue;
                    }
                    const relative = join(dir, entry.name);
                    // Symbolic links are not followed, so a link cycle cannot run away.
                    if (entry.isDirectory()) {
                        add(relative, report);
                    } else if (report) {
                        onChange(relative);
                    }
                }
            });
        };
        add('', false);
        return {
            close: () => {
                closed = true;
                for (const watcher of watchers.values()) {
                    watcher.close();
                }
                watchers.clear();
            },
        };
    };
}

/** Native recursive watching where the system has it (macOS, Windows), a watch per directory elsewhere. */
export function defaultTreeWatch(): WatchTree {
    return process.platform === 'darwin' || process.platform === 'win32' ? nativeTreeWatch : walkingTreeWatch();
}
