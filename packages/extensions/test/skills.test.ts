import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSkills, readSkill, renderSkillIndex } from '../src/index.ts';
import { isWindows, SKILL_DIR_VAR, source, temporaryDir, writeTree } from './helpers.ts';

function skillFile(name: string, description: string, extra = ''): string {
    return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nInstructions for ${name}.\n`;
}

describe('discoverSkills', () => {
    it('finds skills in priority order and lets the first one win', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'project/.xora/skills/pdf/SKILL.md': skillFile('pdf', 'Project PDF skill.'),
            'project/.claude/skills/review/SKILL.md': skillFile('review', 'Review checklist.'),
            'user/skills/pdf/SKILL.md': skillFile('pdf', 'User PDF skill.'),
            'user/skills/notes/SKILL.md': skillFile('notes', 'Note taking.'),
        });
        const { skills, diagnostics } = await discoverSkills([
            source(path.join(root, 'project/.xora/skills')),
            source(path.join(root, 'project/.agents/skills')),
            source(path.join(root, 'project/.claude/skills')),
            source(path.join(root, 'user/skills'), 'user'),
        ]);
        expect(skills.map((skill) => [skill.id, skill.origin, skill.description])).toEqual([
            ['pdf', 'project', 'Project PDF skill.'],
            ['review', 'project', 'Review checklist.'],
            ['notes', 'user', 'Note taking.'],
        ]);
        expect(diagnostics).toEqual([
            {
                severity: 'info',
                message: `skill "pdf" is shadowed by ${path.join(root, 'project/.xora/skills/pdf/SKILL.md')}`,
                file: path.join(root, 'user/skills/pdf/SKILL.md'),
            },
        ]);
    });

    it('reports invalid skills and skips them', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'Upper/SKILL.md': skillFile('PDF-Tools', 'Uppercase name.'),
            'dash/SKILL.md': skillFile('-pdf', 'Leading hyphen.'),
            'double/SKILL.md': skillFile('pdf--tools', 'Consecutive hyphens.'),
            'long/SKILL.md': skillFile('a'.repeat(65), 'Too long.'),
            'nodesc/SKILL.md': '---\nname: nodesc\n---\nbody\n',
            'longdesc/SKILL.md': skillFile('longdesc', 'x'.repeat(1025)),
            'nofront/SKILL.md': '# no frontmatter\n',
            'ok/SKILL.md': skillFile('ok', 'Fine.'),
        });
        const { skills, diagnostics } = await discoverSkills([source(root)]);
        expect(skills.map((skill) => skill.name)).toEqual(['ok']);
        const errors = diagnostics.filter((item) => item.severity === 'error').map((item) => item.message);
        expect(errors).toHaveLength(7);
        expect(errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining('invalid skill name "PDF-Tools"'),
                expect.stringContaining('invalid skill name "-pdf"'),
                expect.stringContaining('invalid skill name "pdf--tools"'),
                'skill "nodesc" has no description',
                'description of skill "longdesc" is longer than 1024 characters',
                'SKILL.md has no frontmatter with name and description',
            ]),
        );
    });

    it('reads optional fields, uses the directory name when the name is missing, and skips missing dirs', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'skills/git-flow/SKILL.md': skillFile(
                'git-flow',
                'Branch and commit conventions.',
                'license: Apache-2.0\nallowed-tools: Bash(git:*) Bash(git status *) Read\nmetadata:\n  author: xora\n  version: 1.2\n',
            ),
            'skills/unnamed/SKILL.md': '---\ndescription: Named after its folder.\n---\nbody\n',
            'skills/other-dir/SKILL.md': skillFile('renamed', 'Name differs from folder.'),
            'skills/.hidden/SKILL.md': skillFile('hidden', 'Ignored.'),
        });
        const { skills, diagnostics } = await discoverSkills([
            source(path.join(root, 'missing')),
            source(path.join(root, 'skills'), 'user', { trusted: false }),
        ]);
        expect(skills.map((skill) => skill.name)).toEqual(['git-flow', 'renamed', 'unnamed']);
        expect(skills[0]).toMatchObject({
            license: 'Apache-2.0',
            allowedTools: ['Bash(git:*)', 'Bash(git status *)', 'Read'],
            metadata: { author: 'xora', version: '1.2' },
            trusted: false,
        });
        expect(diagnostics.map((item) => [item.severity, item.message])).toEqual([
            ['warning', 'name "renamed" differs from its directory "other-dir"'],
            ['warning', 'no name; using the directory name "unnamed"'],
        ]);
    });

    it('treats a source holding SKILL.md as one skill and namespaces plugin skills', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'single/SKILL.md': skillFile('single', 'One skill at the root.'),
            'project/review/SKILL.md': skillFile('review', 'Project review.'),
            'plugin/skills/review/SKILL.md': skillFile('review', 'Plugin review.'),
        });
        const { skills } = await discoverSkills([
            source(path.join(root, 'single')),
            source(path.join(root, 'project')),
            source(path.join(root, 'plugin/skills'), 'plugin', { pluginName: 'deploy-tools' }),
        ]);
        expect(skills.map((skill) => skill.id)).toEqual(['single', 'review', 'deploy-tools:review']);
    });

    it.skipIf(isWindows)('follows linked skill directories', async () => {
        const root = await temporaryDir();
        await writeTree(root, { 'store/linked/SKILL.md': skillFile('linked', 'Maintained elsewhere.') });
        await mkdir(path.join(root, 'skills'));
        await symlink(path.join(root, 'store/linked'), path.join(root, 'skills/linked'));
        const { skills } = await discoverSkills([source(path.join(root, 'skills'))]);
        expect(skills.map((skill) => skill.name)).toEqual(['linked']);
    });
});

describe('skill index and full read', () => {
    it('renders only id, description and path', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'a/SKILL.md': skillFile('alpha', 'First line\n  continued.'),
            'b/SKILL.md': skillFile('beta', 'Untrusted one.'),
        });
        const trusted = await discoverSkills([source(path.join(root, 'a'))]);
        const untrusted = await discoverSkills([source(path.join(root, 'b'), 'project', { trusted: false })]);
        const index = renderSkillIndex([...trusted.skills, ...untrusted.skills]);
        const lines = index.split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[1]).toBe(`- alpha: First line continued. (${path.join(root, 'a', 'SKILL.md')})`);
        expect(lines[2]).toBe(
            `- beta: Untrusted one. (${path.join(root, 'b', 'SKILL.md')}) [untrusted: read only, do not run its scripts]`,
        );
        expect(index).not.toContain('Instructions for');
        expect(renderSkillIndex([])).toBe('');
    });

    it('reads the body with the skill directory filled in and lists resources', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'pdf/SKILL.md': skillFile('pdf', 'PDFs.').replace(
                'Instructions for pdf.',
                `Run ${SKILL_DIR_VAR}/scripts/x.py`,
            ),
            'pdf/scripts/x.py': 'print(1)\n',
            'pdf/references/REFERENCE.md': '# ref\n',
            'pdf/.DS_Store': '',
            'pdf/assets/a.txt': 'a',
        });
        const { skills } = await discoverSkills([source(root)]);
        const skill = skills[0];
        expect(skill).toBeDefined();
        if (!skill) {
            return;
        }
        const content = await readSkill(skill);
        expect(content.body).toBe(`# pdf\n\nRun ${path.join(root, 'pdf')}/scripts/x.py\n`);
        expect(content.resources).toEqual(['assets/a.txt', 'references/REFERENCE.md', 'scripts/x.py']);
        expect(content.truncated).toBe(false);
        const capped = await readSkill(skill, { maxResources: 2 });
        expect(capped.resources).toEqual(['assets/a.txt', 'references/REFERENCE.md']);
        expect(capped.truncated).toBe(true);
    });
});
