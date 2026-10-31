import { describe, expect, it } from 'vitest';
import {
    type BoardResult,
    buildAgentLayers,
    DEFAULT_ORG,
    deliveryReport,
    findAgent,
    judge,
    MAX_FAILED_ACCEPTANCES,
    modelChain,
    needsHuman,
    ProgressLedger,
    parseDeliverable,
    pickReviewerModel,
    resolveTier,
    retryFeedback,
    shouldEscalate,
    TaskBoard,
    TaskLedger,
    type TeamUsage,
    taskGraph,
} from '../src/index.ts';
import { cardInput, fakeClock, followsChineseStyle } from './helpers.ts';

function value<T>(result: BoardResult<T>): T {
    if (!result.ok) {
        throw new Error(result.error.message);
    }
    return result.value;
}

const executorMessage = (taskId: string, exit: number) => `Implemented it.

\`\`\`json
{"taskId": "${taskId}", "status": "done", "summary": "implemented ${taskId}",
 "changes": [{"file": "src/${taskId}/index.ts", "kind": "added"}],
 "evidence": [{"type": "command", "run": "pnpm test src/${taskId}", "exit": ${exit}}]}
\`\`\``;

describe('a supervisor-executor run on top of the package', () => {
    it('plans, dispatches, sends back once, accepts and reports', () => {
        const clock = fakeClock();
        const org = DEFAULT_ORG;
        const board = new TaskBoard({ clock });
        const ledger = new TaskLedger('add sms login', { clock });
        const progress = new ProgressLedger({ clock });
        const usage: TeamUsage[] = [];

        // ③ plan: two dependent cards with disjoint ownership.
        const cards = ['t1', 't2'].map((id, index) =>
            cardInput({
                id,
                title: `step ${index + 1}`,
                dependsOn: index === 0 ? [] : ['t1'],
                ownership: [`src/${id}/**`],
                acceptance: [{ type: 'command', run: `pnpm test src/${id}` }],
            }),
        );
        value(board.addMany(cards));
        ledger.revise({ plan: 'backend first, then the page', tasks: taskGraph(board.list()) }, 'planned');
        expect(needsHuman(org.autonomy, 'plan_approval')).toBe(true);

        const available = [
            { connectionId: 'deepseek', model: 'deepseek-flash', channel: 'api' },
            { connectionId: 'glm', model: 'glm-5.3', channel: 'api' },
            { connectionId: 'deepseek', model: 'deepseek-v4-pro', channel: 'api' },
        ];
        const coder = findAgent(org, 'coder');
        if (!coder) {
            throw new Error('no coder');
        }

        let round = 0;
        while (!board.isComplete()) {
            const [next] = board.dispatchable(1);
            if (!next) {
                throw new Error('stuck');
            }
            const taskId = next.card.id;
            // ⑥ dispatch at the routed tier, with the first model of its chain.
            const tier = resolveTier('executor', next.card, org).tier;
            const [model] = modelChain(tier, org, available);
            expect(model?.model).toBe('deepseek-flash');
            const layers = buildAgentLayers({ org, agent: coder, card: next.card });
            expect(layers.at(-1)?.text).toContain(`<task_card id="${taskId}">`);
            value(board.claim(taskId, `coder-${taskId}`));
            value(board.start(taskId, `coder-${taskId}`));

            // ⑦–⑧ execute, then accept; the first delivery of t1 fails its tests.
            for (;;) {
                round += 1;
                const exit = taskId === 't1' && round === 1 ? 1 : 0;
                const parsed = parseDeliverable(executorMessage(taskId, exit), { taskId });
                if (!parsed.ok) {
                    throw new Error(parsed.error.message);
                }
                usage.push({
                    agentId: `coder-${taskId}`,
                    role: 'executor',
                    tier,
                    taskId,
                    cost: { amount: 1, currency: 'CNY' },
                });
                value(board.submit(taskId, `coder-${taskId}`, parsed.deliverable));
                const reviewer = pickReviewerModel(model?.family, modelChain('standard', org, available));
                expect(reviewer?.crossFamily).toBe(true);
                const judgement = judge(next.card, parsed.deliverable, [{ run: `pnpm test src/${taskId}`, exit }]);
                if (judgement.verdict === 'pass') {
                    value(board.accept(taskId));
                    progress.record({
                        complete: board.isComplete(),
                        progressing: true,
                        looping: false,
                        reason: `${taskId} done`,
                    });
                    break;
                }
                const task = value(board.reject(taskId, judgement.reasons.join('; ')));
                expect(shouldEscalate(task.attempts)).toEqual({ action: 'retry', failures: 1 });
                expect(retryFeedback(judgement, { failures: task.retries })).toContain('last attempt at this tier');
                expect(task.retries).toBeLessThan(MAX_FAILED_ACCEPTANCES);
                progress.record({ complete: false, progressing: false, looping: false, reason: 'tests failed' });
            }
        }
        usage.push({
            agentId: 'supervisor',
            role: 'supervisor',
            tier: 'flagship',
            cost: { amount: 1, currency: 'CNY' },
        });

        expect(progress.stalled()).toBe(false);
        expect(progress.latest?.complete).toBe(true);
        expect(board.topologicalOrder()).toEqual(['t1', 't2']);
        const report = deliveryReport({
            goal: ledger.current.goal,
            cards: board.list(),
            ledger: ledger.current,
            usage,
            language: 'zh-CN',
        });
        expect(report).toContain('结果：完成2/2个任务。');
        expect(report).toContain('- **t1 step 1**（已完成，退回或升级1次）：implemented t1');
        expect(report).toContain('主管花费1.00元，占总花费的25%，在提示线25%以内。');
        expect(followsChineseStyle(report)).toBe(true);
    });
});
