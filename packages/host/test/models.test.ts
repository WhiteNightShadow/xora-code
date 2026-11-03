import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildEngine, type ChatBody, connectMock, gitRepo, hosts, say } from './harness.ts';

/**
 * The model agents run on (06 §25): the user's default model, unless a member has a model of its own; with the team
 * setting `tiers`, each tier's model chain picks, as before.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
}, 60_000);

afterEach(async () => {
    await host.closeAll();
    server.reset();
});

afterAll(async () => {
    await server?.close();
});

describe('the model agents run on', () => {
    it('is the default model unless a member has its own; the tiers pick when the user wants them to', async () => {
        server.respondWith((request) => ((request.body as ChatBody | undefined)?.messages ? say('好。') : undefined));
        const { ui } = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-models-data-')), { models: 'default' });
        await connectMock(ui, server, 'deepseek-v4-pro');
        const project = await ui.request('project.add', { path: gitRepo() });

        // The coder is an economy member: by tier it would run on deepseek-flash.
        const coder = await ui.request('member.chat', { projectId: project.id, memberId: 'coder', text: '看看' });
        expect(coder.model?.model).toBe('deepseek-v4-pro');
        const chief = await ui.request('chief.start', { projectId: project.id, text: '你好' });
        expect(chief.model?.model).toBe('deepseek-v4-pro');

        // A member with a model of its own runs on it.
        const scout = (await ui.request('member.list', { projectId: project.id })).find(
            (member) => member.id === 'scout',
        );
        await ui.request('member.save', {
            projectId: project.id,
            scope: 'user',
            member: {
                id: 'scout',
                name: scout?.name ?? '侦察',
                role: 'scout',
                tier: 'fast',
                model: 'deepseek-flash',
                mode: 'plan',
                prompt: scout?.prompt ?? '',
            },
        });
        const own = await ui.request('member.chat', { projectId: project.id, memberId: 'scout', text: '查查' });
        expect(own.model?.model).toBe('deepseek-flash');

        // By tier: the economy coder gets the economy model.
        const settings = await ui.request('settings.get', {});
        await ui.request('settings.update', { patch: { team: { ...settings.team, models: 'tiers' } } });
        const tiered = await ui.request('member.chat', { projectId: project.id, memberId: 'coder', text: '再看看' });
        expect(tiered.model?.model).toBe('deepseek-flash');
    }, 60_000);
});
