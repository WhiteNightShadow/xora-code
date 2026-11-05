import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildEngine, type ChatBody, connectMock, gitRepo, hosts, say, textOf, type Ui, waitFor } from './harness.ts';

/**
 * The prompt directory (08 §1.4): every .md file in `<data>/prompts` is a global prompt, the user creates, edits,
 * renames and removes them in the settings, and the one they pick is the user global layer of every thread.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'deepseek-flash' }] });
}, 60_000);

afterEach(async () => {
    await host.closeAll();
    server.reset();
});

afterAll(async () => {
    await server?.close();
});

const globalLayer = async (ui: Ui, threadId: string) =>
    (await ui.request('prompt.effective', { threadId })).find((layer) => layer.id === 'user_global_instructions');

describe('prompt directory', () => {
    it('creates, picks, renames and removes global prompts; threads get the one in use', async () => {
        const data = mkdtempSync(path.join(tmpdir(), 'xora-prompt-library-'));
        // What 1.1.0 left: its one global prompt.
        mkdirSync(path.join(data, 'prompts'), { recursive: true });
        writeFileSync(path.join(data, 'prompts', 'global.md'), 'old global');
        const { ui } = await host.start(data);
        const project = await ui.request('project.add', { path: gitRepo() });
        const thread = await ui.request('thread.create', { projectId: project.id });

        let library = await ui.request('prompt.list', {});
        expect(library).toMatchObject({ dir: path.join(data, 'prompts'), selected: 'global' });
        expect(library.items.map((item) => item.name)).toEqual(['global']);
        expect((await globalLayer(ui, thread.id))?.text).toBe('old global');

        await ui.request('prompt.save', { name: 'win/日常', text: '用PowerShell' });
        await ui.request('prompt.select', { name: 'win/日常' });
        expect((await ui.request('settings.get', {})).globalPrompt).toBe('win/日常');
        expect(await globalLayer(ui, thread.id)).toMatchObject({
            text: '用PowerShell',
            source: path.join(data, 'prompts', 'win', '日常.md'),
        });

        // The prompt in use stays in use under its new name.
        await ui.request('prompt.save', { name: 'windows/日常', text: '用PowerShell 5.1', previous: 'win/日常' });
        library = await ui.request('prompt.list', {});
        expect(library.selected).toBe('windows/日常');
        expect(library.items.map((item) => item.name)).toEqual(['global', 'windows/日常']);
        expect((await globalLayer(ui, thread.id))?.text).toBe('用PowerShell 5.1');
        await expect(ui.request('prompt.save', { name: 'global', text: 'x' })).rejects.toThrow(/global/);
        await expect(ui.request('prompt.select', { name: 'nope' })).rejects.toThrow(/nope/);

        // The old way to write the global prompt writes the one in use.
        await ui.request('prompt.set', { scope: 'global', text: 'via set' });
        expect((await ui.request('prompt.read', { name: 'windows/日常' })).text).toBe('via set');

        // Removing the prompt in use leaves none in use, even when a new one gets its name.
        await ui.request('prompt.remove', { name: 'windows/日常' });
        expect((await ui.request('prompt.list', {})).selected).toBeNull();
        expect(await globalLayer(ui, thread.id)).toBeUndefined();
        await ui.request('prompt.save', { name: 'windows/日常', text: 'again' });
        expect((await ui.request('prompt.list', {})).selected).toBeNull();

        // The pick outlives a restart.
        await ui.request('prompt.select', { name: 'windows/日常' });
        await host.closeLast();
        const again = await host.start(data);
        expect((await again.ui.request('prompt.list', {})).selected).toBe('windows/日常');
    });

    it('sends the prompt in use to the model', async () => {
        server.respondWith((request) => ((request.body as ChatBody | undefined)?.messages ? say('好的') : undefined));
        const { ui } = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-prompt-library-')));
        await connectMock(ui, server);
        await ui.request('prompt.save', { name: 'mac/日常', text: '命令按zsh写' });
        await ui.request('prompt.save', { name: 'linux/日常', text: '命令按bash写' });
        await ui.request('prompt.select', { name: 'linux/日常' });
        const project = await ui.request('project.add', { path: gitRepo() });
        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: thread.id, text: '你好' });
        const body = await waitFor(
            () => server.requests.map((request) => request.body as ChatBody | undefined).find((item) => item?.messages),
            'the first model request',
        );
        const system = textOf(body.messages.find((message) => message.role === 'system')?.content);
        expect(system).toContain('命令按bash写');
        expect(system).not.toContain('命令按zsh写');
    });
});
