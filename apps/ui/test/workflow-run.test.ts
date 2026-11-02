import type { WorkflowRun, WorkflowStepRun } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import { absolutePath, filesIn, flowLevels, runFiles } from '../src/workflow-run.ts';

function step(id: string, needs: string[] = [], outputs: Record<string, string> = {}): WorkflowStepRun {
    return { id, type: 'agent', title: id, needs, status: 'pending', attempts: 0, outputs, threadIds: [], cost: null };
}

describe('workflow run view', () => {
    it('puts each step one column after the deepest step it needs', () => {
        // The shape of the keeta workflow: two scouts, then a draft, a review, a gate and a commit.
        const levels = flowLevels([
            step('local_evidence'),
            step('external_research'),
            step('draft_report', ['local_evidence', 'external_research']),
            step('review_report', ['draft_report']),
            step('approve_commit', ['review_report']),
            step('commit_report', ['approve_commit']),
            step('notes', ['local_evidence']),
        ]);
        expect(Object.fromEntries(levels)).toEqual({
            local_evidence: 0,
            external_research: 0,
            draft_report: 1,
            review_report: 2,
            approve_commit: 3,
            commit_report: 4,
            notes: 1,
        });
    });

    it('still draws a broken record: unknown needs and cycles', () => {
        const levels = flowLevels([step('a', ['missing']), step('b', ['c']), step('c', ['b'])]);
        expect(levels.get('a')).toBe(0);
        expect(levels.get('b')).toBeGreaterThanOrEqual(0);
        expect(levels.get('c')).toBeGreaterThanOrEqual(0);
    });

    it('finds the files a step handed in, and only files', () => {
        expect(filesIn('analysis/menu-research.md', '/p')).toEqual(['analysis/menu-research.md']);
        expect(filesIn('README.md', '/p')).toEqual(['README.md']);
        expect(filesIn('/p/src/a.ts, /p/src/b.ts', '/p')).toEqual(['src/a.ts', 'src/b.ts']);
        expect(filesIn('`docs\\guide.md`', '/p')).toEqual(['docs/guide.md']);
        for (const value of [
            'pass',
            'docs: 更新 Keeta 菜品详情抓取调研报告',
            'v1.2',
            '3.14',
            'fooddelivery.mykeeta.com',
            'https://github.com/a/b.md',
            '/etc/hosts.txt',
            '../outside.md',
            '~/notes.md',
            'src/a.ts, not a file',
            '1. 目标 App=Keeta HK 3.13.301',
        ]) {
            expect(filesIn(value, '/p'), value).toEqual([]);
        }
    });

    it('lists each file once, under the step that first handed it in', () => {
        const run = {
            steps: [
                step('draft', [], { reportFile: 'analysis/menu-research.md', count: '3' }),
                step('review', ['draft'], { checked: 'analysis/menu-research.md', verdict: 'pass' }),
            ],
        } as unknown as WorkflowRun;
        expect(runFiles(run, '/p')).toEqual([{ path: 'analysis/menu-research.md', from: 'draft · reportFile' }]);
    });

    it('joins a file to the project path with the separator the project uses', () => {
        expect(absolutePath({ path: '/Users/me/p/' }, 'analysis/a.md')).toBe('/Users/me/p/analysis/a.md');
        expect(absolutePath({ path: 'C:\\work\\p' }, 'analysis/a.md')).toBe('C:\\work\\p\\analysis\\a.md');
        expect(absolutePath(undefined, 'a.md')).toBeUndefined();
    });
});
