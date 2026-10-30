import { describe, expect, it } from 'vitest';
import { deliveryReport, money, TaskBoard, TaskLedger, type TeamUsage, zhStyle } from '../src/index.ts';
import { card, cardInput, deliverable, fakeClock, followsChineseStyle } from './helpers.ts';

const usage: TeamUsage[] = [
    { agentId: 'supervisor', role: 'supervisor', tier: 'flagship', cost: { amount: 3, currency: 'CNY' } },
    { agentId: 'supervisor', role: 'supervisor', tier: 'flagship', cost: { amount: 1, currency: 'CNY' } },
    { agentId: 'coder-1', role: 'executor', tier: 'economy', taskId: 'T1', cost: { amount: 1.5, currency: 'CNY' } },
    { agentId: 'coder-2', role: 'executor', tier: 'economy', taskId: 'T2', cost: { amount: 0.5, currency: 'CNY' } },
    { agentId: 'coder-2', role: 'executor', tier: 'standard', taskId: 'T2', cost: { amount: 2, currency: 'CNY' } },
    { agentId: 'reviewer-1', role: 'reviewer', tier: 'standard', cost: { amount: 1, currency: 'CNY' } },
    { agentId: 'scout-1', role: 'scout', tier: 'fast' },
];

function finishedBoard(): TaskBoard {
    const board = new TaskBoard({ clock: fakeClock() });
    board.addMany([
        cardInput({ id: 'T1', title: '后端：短信验证码 API 接口' }),
        cardInput({ id: 'T2', title: 'Add Redis rate limiting', ownership: ['src/limits/**'] }),
        cardInput({ id: 'T3', title: '前端：登录页', ownership: ['web/login/**'], dependsOn: ['T2'] }),
    ]);
    board.claim('T1', 'coder-1');
    board.submit(
        'T1',
        'coder-1',
        deliverable({
            taskId: 'T1',
            summary: 'Added 2 endpoints using the RateLimiter in src/auth/sms/verify.ts',
            changes: [{ file: 'src/auth/sms/verify.ts', kind: 'added' }],
            evidence: [
                { type: 'command', run: 'pnpm test src/auth', exit: 0 },
                { type: 'diff' },
                { type: 'screenshot', path: 'shots/Login.png' },
                { type: 'note', text: '手动 测试了 5 次' },
            ],
            risks: ['短信服务商的错误码没有全部映射'],
        }),
    );
    board.accept('T1');
    board.claim('T2', 'coder-2');
    board.submit(
        'T2',
        'coder-2',
        deliverable({ taskId: 'T2', changes: [], openQuestions: ['Should limits be per IP?'] }),
    );
    board.reject('T2', 'tests fail');
    board.fail('T2', 'Redis is not available in CI');
    return board;
}

describe('deliveryReport', () => {
    const ledger = new TaskLedger({ goal: '短信登录', decisions: ['验证码5分钟过期'], risks: ['Vendor quota'] });
    const report = deliveryReport({
        goal: 'Add SMS login 到 app',
        cards: finishedBoard().list(),
        ledger: ledger.current,
        usage,
    });

    it('has the five sections of 06 §13', () => {
        for (const heading of ['# 交付报告', '## 做了什么', '## 证据', '## 花费明细', '## 监督开销', '## 遗留问题']) {
            expect(report).toContain(heading);
        }
        expect(report).toContain('目标：add sms login到app');
        expect(report).toContain('结果：完成1/3个任务，失败1个。');
    });

    it('says what was done, with status, retries and changes', () => {
        expect(report).toContain(
            '- **t1后端：短信验证码api接口**（已完成）：added 2 endpoints using the `RateLimiter` in src/auth/sms/verify.ts',
        );
        expect(report).toContain('  - 改动：`src/auth/sms/verify.ts`（新增）');
        expect(report).toContain('- **t2 add redis rate limiting**（失败，退回或升级1次）');
        expect(report).toContain('- **t3前端：登录页**（待开始）');
        expect(report).toContain('关键决定：\n- 验证码5分钟过期');
    });

    it('lists the evidence verbatim', () => {
        expect(report).toContain(
            '- t1：`pnpm test src/auth`（退出码0）；diff；截图`shots/Login.png`；说明：手动 测试了5次',
        );
        expect(report).toContain('- t3：没有证据');
    });

    it('breaks the cost down by tier and agent', () => {
        expect(report).toContain('合计：9.00元。');
        expect(report).toContain('| 旗舰 | 4.00元 | 44% |');
        expect(report).toContain('| 标准 | 3.00元 | 33% |');
        expect(report).toContain('| 经济 | 2.00元 | 22% |');
        expect(report.indexOf('| 旗舰 |')).toBeLessThan(report.indexOf('| 经济 |'));
        expect(report).toContain('| supervisor | 主管 | 旗舰 | 4.00元 | 44% |');
        expect(report).toContain('| coder-2 | 执行者 | 标准、经济 | 2.50元 | 28% |');
    });

    it('warns when supervision exceeds the alert line', () => {
        expect(report).toContain('主管花费4.00元，占总花费的44%，超过提示线25%：任务可能拆得太碎，或者来回沟通太多。');
        const relaxed = deliveryReport({ goal: 'g', cards: [], usage, alertRatio: 0.5 });
        expect(relaxed).toContain('主管花费4.00元，占总花费的44%，在提示线50%以内。');
        expect(deliveryReport({ goal: 'g', cards: [], usage: [] })).toContain('还没有花费记录。');
    });

    it('collects open issues', () => {
        expect(report).toContain('- t1的风险：短信服务商的错误码没有全部映射');
        expect(report).toContain('- t2没有完成（失败）：redis is not available in ci');
        expect(report).toContain('- t2待解答：should limits be per ip?');
        expect(report).toContain('- t3没有完成（待开始）');
        expect(report).toContain('- 计划中的风险：vendor quota');
    });

    it('follows the Chinese style rule outside code', () => {
        expect(followsChineseStyle(report)).toBe(true);
    });

    it('works from plain cards and deliverables, converting currencies', () => {
        const text = deliveryReport({
            goal: 'g',
            cards: [card()],
            deliverables: [deliverable()],
            usage: [
                { agentId: 'a', role: 'executor', tier: 'economy', cost: { amount: 1, currency: 'USD' } },
                { agentId: 'b', role: 'executor', tier: 'economy', cost: { amount: 2, currency: 'CNY' } },
                { agentId: 'c', role: 'executor', tier: 'economy', cost: { amount: 3, currency: 'EUR' } },
            ],
            currency: 'CNY',
            rates: { USD_CNY: 7 },
        });
        expect(text).toContain('（执行者报告完成）');
        expect(text).toContain('合计：9.00元，另有3.00eur未换算。');
        expect(followsChineseStyle(text)).toBe(true);
    });
});

describe('zhStyle', () => {
    it.each([
        ['使用 API 接口', '使用api接口'],
        ['花了 5 分钟', '花了5分钟'],
        ['占 33% 的花费', '占33%的花费'],
        ['改了 `src/A.ts` 文件', '改了`src/A.ts`文件'],
        ['用 TaskBoard 管理', '用`TaskBoard`管理'],
        ['见 README.md', '见`README.md`'],
        ['Done. 完成', 'done. 完成'],
        ['```\nKEEP Me\n```', '```\nKEEP Me\n```'],
        ['花费 $0.50', '花费$0.50'],
    ])('%s → %s', (input, output) => {
        expect(zhStyle(input)).toBe(output);
    });

    it('formats money', () => {
        expect(money(12.3, 'CNY')).toBe('12.30元');
        expect(money(0.5, 'USD')).toBe('$0.50');
        expect(money(0.004, 'CNY')).toBe('0.0040元');
    });
});
