import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HubError, installSkill, listLibrary, memberSkills, searchSkills } from '../src/skill-hub.ts';
import { fakeGitHub, SHA } from './github-fake.ts';

describe('skills from GitHub', () => {
    it('finds skills in the repositories a search returns, the ones matching the query first', async () => {
        const hub = fakeGitHub();
        const found = await searchSkills('pdf', { fetch: hub.fetch });
        expect(found.map((item) => item.name)).toEqual(['pdf-tools', 'web-scraper']);
        expect(found[0]).toEqual({
            repo: 'acme/skills',
            path: 'skills/pdf-tools/SKILL.md',
            name: 'pdf-tools',
            description: 'Read and fill PDF forms.',
            stars: 1200,
            license: 'MIT',
            updatedAt: '2026-10-30T00:00:00Z',
            ref: SHA,
            url: `https://github.com/acme/skills/tree/${SHA}/skills/pdf-tools`,
        });
    });

    it('installs a skill folder pinned to its commit, and refuses what is not one', async () => {
        const hub = fakeGitHub();
        const library = mkdtempSync(path.join(tmpdir(), 'xora-skill-library-'));
        const installed = await installSkill(
            { repo: 'acme/skills', path: 'skills/web-scraper/SKILL.md', ref: SHA },
            library,
            { fetch: hub.fetch },
        );
        expect(installed).toMatchObject({ name: 'web-scraper', files: 2, repo: 'acme/skills', ref: SHA });
        expect(readFileSync(path.join(library, 'web-scraper', 'scripts', 'fetch.py'), 'utf8')).toBe('print("hi")\n');
        expect(existsSync(path.join(library, 'pdf-tools'))).toBe(false);
        expect(JSON.parse(readFileSync(path.join(library, 'web-scraper', '.source.json'), 'utf8'))).toMatchObject({
            repo: 'acme/skills',
            path: 'skills/web-scraper/SKILL.md',
            ref: SHA,
        });
        expect((await listLibrary(library)).map((item) => [item.name, item.repo])).toEqual([
            ['web-scraper', 'acme/skills'],
        ]);
        // Library skills are untrusted: read, not run.
        const skills = await memberSkills(library, ['web-scraper', 'missing', '../escape']);
        expect(skills.map((skill) => [skill.name, skill.trusted])).toEqual([['web-scraper', false]]);

        await expect(
            installSkill({ repo: 'acme/skills', path: 'skills/web-scraper/SKILL.md', ref: 'main' }, library, {
                fetch: hub.fetch,
            }),
        ).rejects.toThrow(HubError);
        await expect(
            installSkill({ repo: 'acme/skills', path: '../SKILL.md', ref: SHA }, library, { fetch: hub.fetch }),
        ).rejects.toThrow('Not a SKILL.md path');
        await expect(
            installSkill({ repo: 'acme/skills', path: 'README.md', ref: SHA }, library, { fetch: hub.fetch }),
        ).rejects.toThrow('Not a SKILL.md path');
    });
});
