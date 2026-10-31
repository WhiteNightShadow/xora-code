import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TriggerSpec, TriggerSpecSchema } from '@xora/workflows';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/log.ts';
import { setLanguageSource } from '../src/text.ts';
import { defaultTreeWatch, type WatchTree, walkingTreeWatch } from '../src/tree-watch.ts';
import {
    newWebhookToken,
    SCHEDULE_GRACE_MS,
    type TriggerFire,
    TriggerService,
    type TriggerServiceOptions,
    type TriggerTarget,
    WEBHOOK_MAX_BYTES,
} from '../src/triggers.ts';

const SH = 'Asia/Shanghai';
const PROJECT = path.join(tmpdir(), 'xora-triggers-project');
const at = (value: string) => Date.parse(value);

const spec = (input: Record<string, unknown>): TriggerSpec => TriggerSpecSchema.parse(input);

interface Harness {
    readonly triggers: TriggerService;
    readonly fires: TriggerFire[];
    readonly logs: string[];
}

const open: TriggerService[] = [];

function harness(options: Partial<TriggerServiceOptions> = {}): Harness {
    const logs: string[] = [];
    const log: Logger = {
        info: (message) => logs.push(`info ${message}`),
        warn: (message) => logs.push(`warn ${message}`),
        error: (message) => logs.push(`error ${message}`),
    };
    const triggers = new TriggerService({ log, ...options });
    open.push(triggers);
    const fires: TriggerFire[] = [];
    triggers.onFire((fire) => fires.push(fire));
    return { triggers, fires, logs };
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = probe();
        if (value !== undefined && value !== false) {
            return value;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Temporary directories, removed after the services watching them have closed. */
const dirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    vi.useRealTimers();
    for (const triggers of open.splice(0)) {
        await triggers.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Schedules ------------------------------------------------------------------------------------------------

describe('TriggerService schedules', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    const nightly = (input: Record<string, unknown>, extra: Partial<TriggerTarget> = {}): TriggerTarget => ({
        key: 'demo:nightly',
        projectDir: PROJECT,
        spec: spec({ timezone: SH, ...input }),
        ...extra,
    });

    it('fires at each schedule time', async () => {
        vi.setSystemTime(at('2026-10-30T08:59:00+08:00'));
        const { triggers, fires } = harness();
        await triggers.update([nightly({ schedule: ['0 9 * * *', '30 9 * * *'] })]);
        expect(triggers.nextScheduledAt('demo:nightly')).toBe(at('2026-10-30T09:00:00+08:00'));
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fires).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(fires).toEqual([
            {
                key: 'demo:nightly',
                reason: 'schedule',
                at: at('2026-10-30T09:00:00+08:00'),
                scheduledFor: at('2026-10-30T09:00:00+08:00'),
            },
        ]);
        expect(triggers.nextScheduledAt('demo:nightly')).toBe(at('2026-10-30T09:30:00+08:00'));
        await vi.advanceTimersByTimeAsync(24.5 * 60 * 60_000);
        expect(fires.map((fire) => new Date(fire.scheduledFor ?? 0).toISOString())).toEqual([
            '2026-10-30T01:00:00.000Z',
            '2026-10-30T01:30:00.000Z',
            '2026-10-31T01:00:00.000Z',
            '2026-10-31T01:30:00.000Z',
        ]);
        expect(fires.every((fire) => fire.at === fire.scheduledFor && fire.missed === undefined)).toBe(true);
    });

    it('checks the wall clock after the system slept, and applies the missed policy', async () => {
        vi.setSystemTime(at('2026-10-30T10:30:00+08:00'));
        const skip = harness();
        const once = harness();
        await skip.triggers.update([nightly({ schedule: '0 * * * *' })]);
        await once.triggers.update([nightly({ schedule: '0 * * * *', missed: 'once' })]);
        // Asleep from 10:30 to 13:00:30: the timers stood still, the wall clock did not.
        vi.setSystemTime(at('2026-10-30T13:00:30+08:00'));
        await vi.advanceTimersByTimeAsync(60_000);
        // 13:00 is only a minute and a half ago, so it runs on time; 11:00 and 12:00 fold into it.
        for (const { fires } of [skip, once]) {
            expect(fires).toHaveLength(1);
            expect(fires[0]).toMatchObject({ reason: 'schedule', scheduledFor: at('2026-10-30T13:00:00+08:00') });
            expect(fires[0]?.missed).toBeUndefined();
            expect(fires[0]?.at).toBeLessThanOrEqual(at('2026-10-30T13:01:30+08:00'));
        }
        // Asleep again from 13:30 to 15:20: 15:00 is too old to count as on time.
        await vi.advanceTimersByTimeAsync(28 * 60_000);
        vi.setSystemTime(at('2026-10-30T15:20:00+08:00'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(skip.fires).toHaveLength(1);
        expect(skip.logs.some((line) => line.includes('skipped the schedule time 2026-10-30T07:00:00.000Z'))).toBe(
            true,
        );
        expect(once.fires).toHaveLength(2);
        expect(once.fires[1]).toMatchObject({
            reason: 'schedule',
            scheduledFor: at('2026-10-30T15:00:00+08:00'),
            missed: true,
        });
        // Both carry on with the next hour.
        expect(skip.triggers.nextScheduledAt('demo:nightly')).toBe(at('2026-10-30T16:00:00+08:00'));
        await vi.advanceTimersByTimeAsync(40 * 60_000);
        expect(skip.fires.at(-1)?.scheduledFor).toBe(at('2026-10-30T16:00:00+08:00'));
        expect(once.fires.at(-1)?.scheduledFor).toBe(at('2026-10-30T16:00:00+08:00'));
    });

    it('waits on when the clock is set back, without firing a time twice', async () => {
        vi.setSystemTime(at('2026-10-30T08:59:30+08:00'));
        const { triggers, fires } = harness();
        await triggers.update([nightly({ schedule: '0 9 * * *' })]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fires).toHaveLength(1);
        vi.setSystemTime(at('2026-10-30T08:00:00+08:00'));
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect(fires).toHaveLength(1);
        expect(triggers.nextScheduledAt('demo:nightly')).toBe(at('2026-10-31T09:00:00+08:00'));
    });

    it('catches up once at startup on a time missed while the app was closed', async () => {
        vi.setSystemTime(at('2026-10-30T10:00:00+08:00'));
        const lastRun = at('2026-10-28T02:00:00+08:00');
        const { triggers, fires } = harness();
        const targets = [
            nightly({ schedule: '0 2 * * *', missed: 'once' }, { key: 'once', lastScheduledAt: lastRun }),
            nightly({ schedule: '0 2 * * *', missed: 'skip' }, { key: 'skip', lastScheduledAt: lastRun }),
            // Never ran: nothing to catch up on.
            nightly({ schedule: '0 2 * * *', missed: 'once' }, { key: 'new' }),
            // Ran at the latest time already.
            nightly(
                { schedule: '0 2 * * *', missed: 'once' },
                { key: 'done', lastScheduledAt: at('2026-10-30T02:00:00+08:00') },
            ),
        ];
        await triggers.update(targets);
        // The 29th and the 30th were missed: one run, for the latest.
        expect(fires).toEqual([
            {
                key: 'once',
                reason: 'schedule',
                at: at('2026-10-30T10:00:00+08:00'),
                scheduledFor: at('2026-10-30T02:00:00+08:00'),
                missed: true,
            },
        ]);
        // The same targets again: nothing new to catch up on.
        await triggers.update(targets);
        expect(fires).toHaveLength(1);
        for (const key of ['once', 'skip', 'new', 'done']) {
            expect(triggers.nextScheduledAt(key)).toBe(at('2026-10-31T02:00:00+08:00'));
        }
    });

    it('runs a time passed moments before startup on time, whatever the policy', async () => {
        vi.setSystemTime(at('2026-10-30T02:03:00+08:00'));
        const { triggers, fires } = harness();
        await triggers.update([
            nightly({ schedule: '0 2 * * *' }, { lastScheduledAt: at('2026-10-29T02:00:00+08:00') }),
        ]);
        expect(fires).toEqual([
            {
                key: 'demo:nightly',
                reason: 'schedule',
                at: at('2026-10-30T02:03:00+08:00'),
                scheduledFor: at('2026-10-30T02:00:00+08:00'),
            },
        ]);
        expect(SCHEDULE_GRACE_MS).toBeGreaterThan(3 * 60_000);
    });

    it('does not fire a recorded time again when the clock went back since', async () => {
        vi.setSystemTime(at('2026-10-30T08:00:00+08:00'));
        const { triggers, fires } = harness();
        await triggers.update([
            nightly({ schedule: '0 9 * * *', missed: 'once' }, { lastScheduledAt: at('2026-10-30T09:00:00+08:00') }),
        ]);
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect(fires).toEqual([]);
        expect(triggers.nextScheduledAt('demo:nightly')).toBe(at('2026-10-31T09:00:00+08:00'));
    });

    it('restarts a changed schedule from now, keeps an unchanged one, stops a removed one', async () => {
        vi.setSystemTime(at('2026-10-30T10:00:30+08:00'));
        const { triggers, fires } = harness();
        const lastScheduledAt = at('2026-10-27T10:00:00+08:00');
        await triggers.update([
            nightly({ schedule: '0 * * * *' }, { key: 'a', lastScheduledAt: at('2026-10-30T10:00:00+08:00') }),
            nightly({ schedule: '0 * * * *' }, { key: 'b' }),
        ]);
        expect(fires).toEqual([]);
        // `a` changes its schedule and `missed` policy: no looking back, even with an old record.
        await triggers.update([
            nightly({ schedule: '15 * * * *', missed: 'once' }, { key: 'a', lastScheduledAt }),
            nightly({ schedule: '0 * * * *' }, { key: 'b' }),
        ]);
        expect(fires).toEqual([]);
        expect(triggers.nextScheduledAt('a')).toBe(at('2026-10-30T10:15:00+08:00'));
        expect(triggers.nextScheduledAt('b')).toBe(at('2026-10-30T11:00:00+08:00'));
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        expect(fires.map((fire) => fire.key)).toEqual(['a']);
        await triggers.update([nightly({ schedule: '0 * * * *' }, { key: 'b' })]);
        expect(triggers.nextScheduledAt('a')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect(fires.map((fire) => fire.key)).toEqual(['a', 'b', 'b']);
    });

    it('logs a schedule it cannot read instead of starting it', async () => {
        vi.setSystemTime(at('2026-10-30T10:00:00+08:00'));
        const { triggers, logs } = harness();
        const broken = { ...spec({}), schedule: '61 * * * *' };
        await triggers.update([
            { key: 'bad', projectDir: PROJECT, spec: broken },
            nightly({ schedule: '0 * * * *', timezone: 'Mars/Olympus_Mons' }, { key: 'zone' }),
        ]);
        expect(triggers.nextScheduledAt('bad')).toBeUndefined();
        expect(triggers.nextScheduledAt('zone')).toBeUndefined();
        expect(logs.filter((line) => line.startsWith('warn')).length).toBe(2);
    });

    it('stops everything on close', async () => {
        vi.setSystemTime(at('2026-10-30T08:59:00+08:00'));
        const { triggers, fires } = harness();
        await triggers.update([nightly({ schedule: '0 9 * * *' })]);
        await triggers.close();
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect(fires).toEqual([]);
        await triggers.update([nightly({ schedule: '0 9 * * *' })]);
        expect(triggers.nextScheduledAt('demo:nightly')).toBeUndefined();
    });
});

// Files ----------------------------------------------------------------------------------------------------

/** A watcher the test drives by hand. */
function handWatcher() {
    const listeners = new Map<string, (relative: string) => void>();
    const stats = { opened: 0, closed: 0 };
    const watchTree: WatchTree = (root, onChange) => {
        stats.opened++;
        listeners.set(root, onChange);
        return {
            close: () => {
                stats.closed++;
                listeners.delete(root);
            },
        };
    };
    const change = (root: string, ...files: string[]) => {
        for (const file of files) {
            listeners.get(path.resolve(root))?.(file);
        }
    };
    return { watchTree, change, stats };
}

describe('TriggerService file triggers', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(at('2026-10-30T10:00:00+08:00'));
    });

    const watching = (files: Record<string, unknown>, key = 'demo:lint'): TriggerTarget => ({
        key,
        projectDir: PROJECT,
        spec: spec({ files }),
    });

    it('fires once the matching changes settle, with the changed paths', async () => {
        const hand = handWatcher();
        const { triggers, fires } = harness({ watchTree: hand.watchTree });
        await triggers.update([watching({ paths: ['src/**/*.ts'], ignore: ['src/gen/**'], debounceSeconds: 10 })]);
        hand.change(PROJECT, 'src/a.ts', 'docs/readme.md', 'src/gen/types.ts');
        await vi.advanceTimersByTimeAsync(4_000);
        hand.change(PROJECT, 'src/b.ts', 'node_modules/x/src/c.ts', '.git/index', 'src\\win\\d.ts');
        await vi.advanceTimersByTimeAsync(4_000);
        hand.change(PROJECT, 'src/a.ts');
        await vi.advanceTimersByTimeAsync(9_999);
        expect(fires).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(fires).toEqual([
            {
                key: 'demo:lint',
                reason: 'files',
                at: at('2026-10-30T10:00:18+08:00'),
                files: ['src/a.ts', 'src/b.ts', 'src/win/d.ts'],
            },
        ]);
        // Changes outside the globs never start the wait.
        hand.change(PROJECT, 'docs/other.md');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fires).toHaveLength(1);
    });

    it('shares one watcher among the triggers of a project', async () => {
        const hand = handWatcher();
        const { triggers, fires } = harness({ watchTree: hand.watchTree });
        await triggers.update([
            watching({ paths: ['src'], debounceSeconds: 1 }, 'a'),
            watching({ paths: ['docs/'], debounceSeconds: 2 }, 'b'),
        ]);
        expect(hand.stats.opened).toBe(1);
        hand.change(PROJECT, 'src/x/y.ts', 'docs/z.md', 'srcfile');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fires.map((fire) => [fire.key, fire.files])).toEqual([
            ['a', ['src/x/y.ts']],
            ['b', ['docs/z.md']],
        ]);
        await triggers.update([watching({ paths: ['src'], debounceSeconds: 1 }, 'a')]);
        expect(hand.stats.closed).toBe(0);
        await triggers.update([]);
        expect(hand.stats.closed).toBe(1);
    });

    it('drops changes while muted and for a grace period after', async () => {
        const hand = handWatcher();
        const { triggers, fires } = harness({ watchTree: hand.watchTree, muteGraceMs: 2_000 });
        await triggers.update([watching({ paths: ['**'], debounceSeconds: 1 })]);
        const unmute = triggers.muteFiles(PROJECT);
        const nested = triggers.muteFiles(`${PROJECT}/`);
        hand.change(PROJECT, 'a.txt');
        unmute();
        unmute();
        hand.change(PROJECT, 'b.txt');
        nested();
        await vi.advanceTimersByTimeAsync(1_500);
        // Still within the grace period: a late event of the muted writes.
        hand.change(PROJECT, 'c.txt');
        await vi.advanceTimersByTimeAsync(1_000);
        hand.change(PROJECT, 'd.txt');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fires.map((fire) => fire.files)).toEqual([['d.txt']]);
    });

    it('keeps at most 200 paths in a fire', async () => {
        const hand = handWatcher();
        const { triggers, fires } = harness({ watchTree: hand.watchTree });
        await triggers.update([watching({ paths: ['**'], debounceSeconds: 1 })]);
        hand.change(PROJECT, ...Array.from({ length: 300 }, (_, index) => `f${String(index).padStart(3, '0')}.txt`));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fires[0]?.files).toHaveLength(200);
        expect(fires[0]?.files?.[199]).toBe('f199.txt');
    });

    it('restarts the subscription when the globs change and drops pending changes of removed triggers', async () => {
        const hand = handWatcher();
        const { triggers, fires } = harness({ watchTree: hand.watchTree });
        await triggers.update([watching({ paths: ['src'], debounceSeconds: 5 })]);
        hand.change(PROJECT, 'src/a.ts');
        await triggers.update([watching({ paths: ['lib'], debounceSeconds: 5 })]);
        hand.change(PROJECT, 'src/b.ts', 'lib/c.ts');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fires.map((fire) => fire.files)).toEqual([['lib/c.ts']]);
        hand.change(PROJECT, 'lib/d.ts');
        await triggers.update([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fires).toHaveLength(1);
    });
});

describe('TriggerService file triggers on the real file system', () => {
    function project(): string {
        const dir = tempDir('xora-triggers-files-');
        mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
        mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
        return dir;
    }

    it('fires for files written under the watched globs', async () => {
        const dir = project();
        const { triggers, fires } = harness();
        await triggers.update([
            { key: 'real', projectDir: dir, spec: spec({ files: { paths: ['src/**/*.ts'], debounceSeconds: 1 } }) },
        ]);
        // Let the watcher settle so the setup above is not reported.
        await pause(300);
        writeFileSync(path.join(dir, 'src', 'deep', 'a.ts'), 'export {};\n');
        writeFileSync(path.join(dir, 'node_modules', 'pkg', 'b.ts'), 'export {};\n');
        writeFileSync(path.join(dir, 'src', 'c.md'), '# c\n');
        const fire = await waitFor(() => fires[0], 'a file fire');
        expect(fire).toMatchObject({ key: 'real', reason: 'files', files: ['src/deep/a.ts'] });
    }, 30_000);

    // The watcher per directory is for Linux; Windows cannot remove a directory while it is being watched.
    const watchers: Array<[string, WatchTree]> = [['the default watcher', defaultTreeWatch()]];
    if (process.platform !== 'win32') {
        watchers.push(['a watcher per directory', walkingTreeWatch()]);
    }

    it.each(watchers)(
        '%s reports nested changes and new directories, skipping node_modules',
        async (_name, watchTree) => {
            const dir = project();
            const seen = new Set<string>();
            const errors: Error[] = [];
            const watcher = watchTree(
                dir,
                (relative) => seen.add(relative),
                (error) => errors.push(error),
            );
            try {
                await pause(300);
                writeFileSync(path.join(dir, 'src', 'deep', 'a.ts'), 'a');
                writeFileSync(path.join(dir, 'node_modules', 'pkg', 'b.ts'), 'b');
                mkdirSync(path.join(dir, 'fresh', 'inner'), { recursive: true });
                writeFileSync(path.join(dir, 'fresh', 'inner', 'c.ts'), 'c');
                await waitFor(() => seen.has('src/deep/a.ts') && seen.has('fresh/inner/c.ts'), 'nested changes');
                // A file written later into the new directory is seen too.
                writeFileSync(path.join(dir, 'fresh', 'inner', 'd.ts'), 'd');
                await waitFor(() => seen.has('fresh/inner/d.ts'), 'a change in a new directory');
                // So is one in a directory removed and made again.
                rmSync(path.join(dir, 'fresh'), { recursive: true });
                mkdirSync(path.join(dir, 'fresh', 'inner'), { recursive: true });
                await pause(300);
                writeFileSync(path.join(dir, 'fresh', 'inner', 'e.ts'), 'e');
                await waitFor(() => seen.has('fresh/inner/e.ts'), 'a change in a directory made again');
                // A change to the watched directory itself names no path in it; a child of the same name does.
                chmodSync(dir, 0o755);
                chmodSync(path.join(dir, 'src'), 0o755);
                writeFileSync(path.join(dir, 'src', 'src'), 'named like its directory');
                await waitFor(() => seen.has('src/src'), 'a file named like its directory');
                await pause(300);
                expect(seen.has(path.basename(dir))).toBe(false);
                expect([...seen].filter((relative) => relative.startsWith('node_modules'))).toEqual([]);
                expect(errors).toEqual([]);
            } finally {
                watcher.close();
            }
        },
        30_000,
    );

    it('stays quiet when the walking watcher limit is reached, and says so', async () => {
        const dir = project();
        const errors: Error[] = [];
        const watcher = walkingTreeWatch(2)(
            dir,
            () => undefined,
            (error) => errors.push(error),
        );
        try {
            await waitFor(() => errors[0], 'the limit warning');
            expect(errors[0]?.message).toMatch(/more than 2 directories/);
        } finally {
            watcher.close();
        }
    }, 30_000);
});

// Git ------------------------------------------------------------------------------------------------------

describe('TriggerService git triggers', () => {
    function repo() {
        const dir = tempDir('xora-triggers-git-');
        const git = (...args: string[]) =>
            execFileSync(
                'git',
                [
                    '-c',
                    'user.email=test@example.com',
                    '-c',
                    'user.name=Test',
                    '-c',
                    'commit.gpgsign=false',
                    '-c',
                    'core.hooksPath=/dev/null',
                    ...args,
                ],
                { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
            ).trim();
        git('init', '-q', '-b', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'init');
        const commit = (message: string) => {
            git('commit', '-q', '--allow-empty', '-m', message);
            return git('rev-parse', 'HEAD');
        };
        return { dir, git, commit };
    }

    const watchGit = (dir: string, git: Record<string, unknown>, key = 'demo:git'): TriggerTarget => ({
        key,
        projectDir: dir,
        spec: spec({ git }),
    });

    it('fires for new commits on watched branches after a quiet baseline', async () => {
        const { dir, git, commit } = repo();
        const { triggers, fires } = harness({ gitPollMs: 50 });
        await triggers.update([
            watchGit(dir, { on: ['commit'] }, 'any'),
            watchGit(dir, { on: ['commit'], branches: ['release/*'] }, 'release'),
        ]);
        await pause(200);
        expect(fires).toEqual([]);
        const first = commit('one');
        await waitFor(() => fires.find((fire) => fire.key === 'any'), 'a commit fire');
        expect(fires).toEqual([
            {
                key: 'any',
                reason: 'git',
                at: expect.any(Number),
                git: { event: 'commit', branch: 'main', commit: first },
            },
        ]);
        // A branch made from a known commit brings nothing new; a commit on it does.
        git('checkout', '-q', '-b', 'release/1.0');
        await pause(200);
        expect(fires).toHaveLength(1);
        const second = commit('two');
        await waitFor(() => fires.find((fire) => fire.key === 'release'), 'a release commit fire');
        await pause(150);
        expect(fires.slice(1).map((fire) => [fire.key, fire.git])).toEqual([
            ['any', { event: 'commit', branch: 'release/1.0', commit: second }],
            ['release', { event: 'commit', branch: 'release/1.0', commit: second }],
        ]);
    }, 30_000);

    it('fires for new branches when asked to', async () => {
        const { dir, git } = repo();
        const { triggers, fires } = harness({ gitPollMs: 50 });
        await triggers.update([watchGit(dir, { on: ['branch'] })]);
        git('branch', 'feature/x');
        const fire = await waitFor(() => fires[0], 'a branch fire');
        expect(fire.git).toEqual({ event: 'branch', branch: 'feature/x', commit: git('rev-parse', 'HEAD') });
        // A commit is not a branch event.
        git('checkout', '-q', 'feature/x');
        git('commit', '-q', '--allow-empty', '-m', 'x');
        await pause(300);
        expect(fires).toHaveLength(1);
    }, 30_000);

    it('takes commits made while muted into the baseline', async () => {
        const { dir, commit } = repo();
        const { triggers, fires } = harness({ gitPollMs: 50 });
        await triggers.update([watchGit(dir, { on: ['commit'] })]);
        const unmute = triggers.muteGit(dir);
        commit('by the workflow');
        // Polls while muted are silent.
        await pause(300);
        // Committed just before the unmute: the silent poll the unmute starts takes it in.
        commit('by the workflow, last');
        unmute();
        await pause(300);
        expect(fires).toEqual([]);
        const later = commit('by the user');
        await waitFor(() => fires[0], 'a commit fire after the unmute');
        await pause(150);
        expect(fires.map((fire) => fire.git?.commit)).toEqual([later]);
    }, 30_000);

    it('logs a directory that is not a repository once', async () => {
        const dir = tempDir('xora-triggers-plain-');
        const { triggers, logs } = harness({ gitPollMs: 50 });
        await triggers.update([watchGit(dir, { on: ['commit'] })]);
        await pause(300);
        expect(logs.filter((line) => line.startsWith('warn') && line.includes('git trigger'))).toHaveLength(1);
    }, 30_000);
});

// Webhook --------------------------------------------------------------------------------------------------

interface Reply {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
}

function send(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] } = {},
): Promise<Reply> {
    return new Promise((resolve, reject) => {
        let answered = false;
        const req = request(url, { method: init.method ?? 'POST', headers: init.headers }, (res) => {
            answered = true;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
            );
        });
        // The server may answer early and close while the body is still being sent.
        req.on('error', (error) => {
            if (!answered) reject(error);
        });
        for (const chunk of init.chunks ?? []) {
            req.write(chunk);
        }
        req.end(init.body);
    });
}

describe('TriggerService webhook', () => {
    const TOKEN = 'secret-token-123';
    const KEY = 'demo project/nightly:1';
    let clock = at('2026-10-30T10:00:00+08:00');
    beforeEach(() => {
        clock = at('2026-10-30T10:00:00+08:00');
    });

    async function serve(extra: Partial<TriggerTarget> = {}) {
        const h = harness({ now: () => clock });
        await h.triggers.update([
            { key: KEY, projectDir: PROJECT, spec: spec({ webhook: true }), webhookToken: TOKEN, ...extra },
        ]);
        const url = h.triggers.webhookUrl(KEY);
        if (!url) throw new Error('no webhook url');
        return { ...h, url };
    }

    const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

    it('accepts a JSON post with the token, answers 202 and fires', async () => {
        const { triggers, fires, url } = await serve();
        expect(url).toBe(`http://127.0.0.1:${triggers.webhookPort()}/hooks/demo%20project%2Fnightly%3A1`);
        const reply = await send(url, {
            headers: { ...auth(), 'content-type': 'application/json' },
            body: JSON.stringify({ issue: '登录失败', count: 2 }),
        });
        expect(reply.status).toBe(202);
        expect(JSON.parse(reply.body)).toEqual({ accepted: true });
        expect(fires).toEqual([{ key: KEY, reason: 'webhook', at: clock, payload: { issue: '登录失败', count: 2 } }]);
    });

    it('passes text bodies on as text and empty bodies as nothing', async () => {
        const { fires, url } = await serve();
        expect((await send(url, { headers: { ...auth(), 'content-type': 'text/plain' }, body: 'deploy' })).status).toBe(
            202,
        );
        clock += 5_000;
        expect((await send(url, { headers: auth() })).status).toBe(202);
        expect(fires.map((fire) => fire.payload)).toEqual(['deploy', undefined]);
        expect('payload' in (fires[1] ?? {})).toBe(false);
    });

    it('limits each key to one fire per five seconds', async () => {
        const { fires, url } = await serve();
        expect((await send(url, { headers: auth() })).status).toBe(202);
        clock += 2_000;
        const limited = await send(url, { headers: auth() });
        expect(limited.status).toBe(429);
        expect(limited.headers['retry-after']).toBe('3');
        clock += 3_000;
        expect((await send(url, { headers: auth() })).status).toBe(202);
        expect(fires).toHaveLength(2);
    });

    it('rejects bad tokens, other methods, paths and hosts, and invalid JSON', async () => {
        const { fires, url } = await serve();
        const unauthorized = await send(url, { headers: auth('wrong-token') });
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers['www-authenticate']).toBe('Bearer');
        expect((await send(url)).status).toBe(401);
        expect((await send(url, { headers: { authorization: TOKEN } })).status).toBe(401);
        const wrongMethod = await send(url, { method: 'GET', headers: auth() });
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.allow).toBe('POST');
        expect((await send(url.replace(/\/hooks\/.*/, '/hooks/unknown'), { headers: auth() })).status).toBe(404);
        expect((await send(url.replace(/\/hooks\/.*/, '/other'), { headers: auth() })).status).toBe(404);
        expect((await send(`${url}/extra`, { headers: auth() })).status).toBe(404);
        expect((await send(url, { headers: { ...auth(), host: 'evil.example:80' } })).status).toBe(403);
        const invalid = await send(url, { headers: { ...auth(), 'content-type': 'application/json' }, body: '{nope' });
        expect(invalid.status).toBe(400);
        expect(JSON.parse(invalid.body).error).toBe('请求体不是合法的json');
        expect(fires).toEqual([]);
    });

    it('answers in the host language', async () => {
        setLanguageSource(() => 'en');
        try {
            const { url } = await serve();
            const unauthorized = await send(url, { headers: auth('wrong-token') });
            expect(JSON.parse(unauthorized.body).error).toBe('The token is missing or wrong');
            const invalid = await send(url, {
                headers: { ...auth(), 'content-type': 'application/json' },
                body: '{nope',
            });
            expect(JSON.parse(invalid.body).error).toBe('The request body is not valid JSON');
        } finally {
            setLanguageSource(() => 'zh-CN');
        }
    });

    it('refuses bodies over 64 KB, announced or streamed', async () => {
        const { fires, url } = await serve();
        const big = Buffer.alloc(WEBHOOK_MAX_BYTES + 1, 'a');
        expect((await send(url, { headers: auth(), body: big })).status).toBe(413);
        const streamed = await send(url, {
            headers: auth(),
            chunks: [big.subarray(0, 40_000)],
            body: big.subarray(40_000),
        });
        expect(streamed.status).toBe(413);
        expect((await send(url, { headers: auth(), body: Buffer.alloc(WEBHOOK_MAX_BYTES, 'a') })).status).toBe(202);
        expect(fires).toHaveLength(1);
    });

    it('has no webhook without a token, and none after it is switched off or the service closes', async () => {
        const { triggers, logs, url } = await serve();
        await triggers.update([{ key: KEY, projectDir: PROJECT, spec: spec({ webhook: true }) }]);
        expect(triggers.webhookUrl(KEY)).toBeUndefined();
        expect((await send(url, { headers: auth() })).status).toBe(404);
        const other = harness();
        await other.triggers.update([{ key: 'k', projectDir: PROJECT, spec: spec({ webhook: true }) }]);
        expect(other.triggers.webhookUrl('k')).toBeUndefined();
        expect(other.logs.some((line) => line.includes('without a token'))).toBe(true);
        expect(logs.some((line) => line.includes('webhook server listening on 127.0.0.1:'))).toBe(true);
        await triggers.close();
        await expect(send(url, { headers: auth() })).rejects.toThrow();
    });

    it('makes tokens a bearer header can carry', async () => {
        const token = newWebhookToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(newWebhookToken()).not.toBe(token);
        const { fires, url } = await serve({ webhookToken: token });
        expect((await send(url, { headers: auth(token) })).status).toBe(202);
        expect(fires).toHaveLength(1);
    });

    it('keeps a chosen port and falls back to a free one when it is taken', async () => {
        const first = await serve();
        const port = first.triggers.webhookPort();
        const second = harness({ webhookPort: port });
        await second.triggers.update([
            { key: KEY, projectDir: PROJECT, spec: spec({ webhook: true }), webhookToken: TOKEN },
        ]);
        expect(second.triggers.webhookPort()).toBeGreaterThan(0);
        expect(second.triggers.webhookPort()).not.toBe(port);
        expect(second.logs.some((line) => line.includes(`webhook port ${port} is taken`))).toBe(true);
    });
});
