import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import {
    createJobRegistry,
    type ManagedJobRegistry,
    sanitizeEnv,
    type TodoItem,
    type ToolContext,
    type ToolDefinition,
    type ToolResult,
} from '../src/index.ts';

const temporaryDirs: string[] = [];
const registries: ManagedJobRegistry[] = [];

afterEach(async () => {
    for (const jobs of registries.splice(0)) {
        jobs.killAll();
    }
    for (const dir of temporaryDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
});

export const isWindows = process.platform === 'win32';

/** A new empty directory, as a real path: on macOS the temporary directory sits behind `/var` → `/private/var`. */
export async function temporaryDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'xora-tools-test-')));
    temporaryDirs.push(dir);
    return dir;
}

/** Writes `files` (relative path → content) below `root`, creating directories as needed. */
export async function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    }
}

export interface TestContext extends ToolContext {
    readonly controller: AbortController;
    readonly jobs: ManagedJobRegistry;
    /** Chunks passed to `onOutput`. */
    readonly chunks: string[];
    /** Artifacts saved through `artifacts.save`. */
    readonly saved: Array<{ readonly name: string; readonly path: string }>;
    readonly todoItems: () => readonly TodoItem[];
}

export async function makeContext(
    cwd: string,
    overrides: Partial<Omit<ToolContext, 'jobs'>> = {},
): Promise<TestContext> {
    const controller = new AbortController();
    const chunks: string[] = [];
    const saved: Array<{ name: string; path: string }> = [];
    const artifactDir = await temporaryDir();
    const jobs = createJobRegistry();
    registries.push(jobs);
    let todos: readonly TodoItem[] = [];
    return {
        cwd,
        roots: [cwd],
        signal: controller.signal,
        env: sanitizeEnv(process.env),
        artifacts: {
            async save(name, content) {
                const file = path.join(artifactDir, name);
                await writeFile(file, content);
                saved.push({ name, path: file });
                return file;
            },
        },
        jobs,
        todos: {
            get: () => todos,
            set: (items) => {
                todos = items;
            },
        },
        onOutput: (chunk) => chunks.push(chunk),
        controller,
        chunks,
        saved,
        todoItems: () => todos,
        ...overrides,
    };
}

/** Validates `input` with the tool's schema, as the engine does, and runs the tool. */
export function runTool<Input>(tool: ToolDefinition<Input>, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    return tool.run(tool.schema.parse(input), ctx);
}

/** Polls `condition` until it holds or `timeoutMs` passes. */
export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return condition();
}

/** Whether a process with this id still exists (zombies included). */
export function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
