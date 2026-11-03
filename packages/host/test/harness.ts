import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type Approval,
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcPeer,
} from '@xora/protocol';
import type { MockModelServer, MockTurn, OpenAiToolCall } from '@xora/test-kit';
import { openaiText, openaiToolCalls } from '@xora/test-kit';
import { build } from 'esbuild';
import { HostCore } from '../src/core.ts';
import type { Logger } from '../src/log.ts';
import { MemoryShell } from '../src/shell.ts';

/**
 * Headless host for end-to-end tests: the real host and xora engine (bundled once per test file) against a
 * scripted model server, with a UI peer over a MessageChannel.
 */

export type Ui = RpcPeer<HostMethods, HostNotifications>;

export interface Harness {
    readonly core: HostCore;
    readonly ui: Ui;
    close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Bundles the engine into a temporary file; call from `beforeAll`. */
export async function buildEngine(): Promise<string> {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'xora-engine-')), 'engine.cjs');
    await build({
        entryPoints: [path.resolve(here, '../../engine/src/main.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: out,
        logLevel: 'silent',
    });
    return out;
}

/** Starts hosts on data folders; a second start on the same folder is a restart. */
export function hosts(engineEntry: () => string) {
    const shells = new Map<string, MemoryShell>();
    const open: Harness[] = [];
    return {
        /**
         * `reviewer`: who answers approval cards (06 §24). The tests answer them as the user unless they test the
         * supervisor's review.
         */
        async start(
            dataDir: string,
            extra: { readonly fetch?: typeof fetch; readonly reviewer?: 'supervisor' | 'user' } = {},
        ): Promise<Harness> {
            const shell = shells.get(dataDir) ?? new MemoryShell({ dataDir });
            shells.set(dataDir, shell);
            const core = await HostCore.create({
                dataDir,
                shell,
                bundleVersion: '1.0.0-test',
                shellVersion: '1.0.0-test',
                engineEntry: engineEntry(),
                skipShellEnv: true,
                log: quiet,
                ...(extra.fetch ? { fetch: extra.fetch } : {}),
            });
            core.settings.update({ approvals: { reviewer: extra.reviewer ?? 'user' } });
            const channel = new MessageChannel();
            const hostSide = core.connectUi(domPortTransport(channel.port1));
            const ui: Ui = new RpcPeer(domPortTransport(channel.port2), { methods, notifications, timeoutMs: 60_000 });
            const harness: Harness = {
                core,
                ui,
                close: async () => {
                    ui.dispose();
                    hostSide.dispose();
                    channel.port1.close();
                    channel.port2.close();
                    await core.dispose();
                },
            };
            open.push(harness);
            return harness;
        },
        /** Closes every host still open; call from `afterEach`. */
        async closeAll(): Promise<void> {
            for (const harness of open.splice(0)) {
                await harness.close().catch(() => undefined);
            }
        },
        /** Closes the latest host, to start it again on the same folder. */
        async closeLast(): Promise<void> {
            await open.pop()?.close();
        },
    };
}

export async function waitFor<T>(
    probe: () => T | undefined | Promise<T | undefined>,
    what: string,
    timeoutMs = 60_000,
): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== undefined && value !== false) {
            return value as T;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** A git repository with a README and the given files, committed. */
export function gitRepo(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

// Scripted model ---------------------------------------------------------------------------------------------

export const USAGE = { prompt_tokens: 3000, completion_tokens: 400 };

export interface ChatMessage {
    readonly role: string;
    readonly content: unknown;
    readonly tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
}

export interface ChatBody {
    readonly model: string;
    readonly messages: readonly ChatMessage[];
    readonly tools?: ReadonlyArray<{ function: { name: string } }>;
}

export function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
    return '';
}

/** Which roster agent a request comes from: the engine renders the agent layer with its title. */
export function agentOf(body: ChatBody | undefined): string {
    const system = textOf(body?.messages?.find((message) => message.role === 'system')?.content);
    return /<agent_instructions title="agent：([^"]+)"/.exec(system)?.[1] ?? 'none';
}

export function lastCall(body: ChatBody): string | undefined {
    const assistant = [...body.messages].reverse().find((message) => message.role === 'assistant');
    return assistant?.tool_calls?.at(-1)?.function.name;
}

/** Every user message of the request, joined. */
export function userText(body: ChatBody): string {
    return body.messages
        .filter((message) => message.role === 'user')
        .map((message) => textOf(message.content))
        .join('\n');
}

export const say = (text: string): MockTurn => openaiText(text, { usage: USAGE });
export const call = (...calls: OpenAiToolCall[]): MockTurn => openaiToolCalls(calls, { usage: USAGE });

/** Answers approval cards like a user, except the tools in `hold`. */
export function approveAll(ui: Ui, seen: Approval[] = [], hold: ReadonlySet<string> = new Set()): Approval[] {
    ui.onNotification('approval.requested', ({ approval }) => {
        seen.push(approval);
        if (approval.toolName && hold.has(approval.toolName)) {
            return;
        }
        void ui
            .request('approval.respond', { approvalId: approval.id, decision: 'allow_session' })
            .catch(() => undefined);
    });
    return seen;
}

/** A custom OpenAI-compatible connection to the mock server, made the default model. */
export async function connectMock(ui: Ui, server: MockModelServer, model = 'deepseek-flash'): Promise<string> {
    const connection = await ui.request('provider.save', {
        presetId: 'custom-openai',
        name: 'mock',
        apiKey: 'test-key',
        baseUrl: server.url,
    });
    await ui.request('provider.refreshModels', { connectionId: connection.id });
    await ui.request('settings.update', { patch: { defaultModel: { connectionId: connection.id, model } } });
    return connection.id;
}
