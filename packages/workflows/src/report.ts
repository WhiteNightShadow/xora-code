import type { BoardTask, TaskStatus } from './board.ts';
import type { TaskLedgerContent } from './ledgers.ts';
import { DEFAULT_SUPERVISION_ALERT_RATIO, ROLES, type Role } from './org.ts';
import { TIER_ORDER } from './routing.ts';
import type { ChangeKind, Deliverable, DeliverableStatus, Evidence, TaskCard, Tier } from './schemas.ts';
import { money, percent, ROLE_LABELS, TIER_LABELS, zhStyle } from './style.ts';

/**
 * The delivery report (06 §5 ⑪, §13): what was done, the evidence, cost by tier and agent, the supervision
 * overhead and open issues, as Chinese markdown in the user's style.
 */

/** One usage record. `UsageEvent` of `@xora/metering` fits as is. */
export interface TeamUsage {
    readonly agentId?: string;
    readonly role?: string;
    readonly tier?: string;
    readonly taskId?: string;
    readonly cost?: { readonly amount: number; readonly currency: string };
}

export interface DeliveryReportInput {
    readonly goal: string;
    /** Cards, or board tasks, which add the board status. */
    readonly cards: readonly (TaskCard | BoardTask)[];
    /** The latest deliverable of each task; board tasks also carry theirs. */
    readonly deliverables?: readonly Deliverable[];
    readonly ledger?: Pick<TaskLedgerContent, 'decisions' | 'risks'>;
    readonly usage: readonly TeamUsage[];
    /** Supervision overhead alert line: the organization's `supervisionAlertRatio`, 25% by default. */
    readonly alertRatio?: number;
    /** Currency of the totals; the first cost's currency by default. */
    readonly currency?: string;
    /** Exchange rates keyed `FROM_TO`, e.g. `{ USD_CNY: 7.1 }`, as in `@xora/metering`. */
    readonly rates?: Readonly<Record<string, number>>;
}

const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
    pending: '待开始',
    ready: '待派工',
    assigned: '已派工',
    in_progress: '进行中',
    in_review: '验收中',
    done: '已完成',
    failed: '失败',
    blocked: '受阻',
    cancelled: '已取消',
};

const DELIVERABLE_LABELS: Readonly<Record<DeliverableStatus, string>> = {
    done: '执行者报告完成',
    partial: '部分完成',
    blocked: '受阻',
    escalate: '已升级',
};

const CHANGE_LABELS: Readonly<Record<ChangeKind, string>> = {
    added: '新增',
    modified: '修改',
    deleted: '删除',
    renamed: '重命名',
};

const UNKNOWN = '未知';

interface ReportTask {
    readonly card: TaskCard;
    readonly status?: TaskStatus;
    /** Attempts that did not pass: sent back or escalated. */
    readonly retries: number;
    readonly deliverable?: Deliverable;
    readonly note?: string;
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function code(text: string): string {
    const clean = oneLine(text);
    const fence = clean.includes('`') ? '``' : '`';
    return `${fence}${clean}${fence}`;
}

function cell(text: string): string {
    return oneLine(text).replaceAll('|', '\\|');
}

function statusLabel(task: ReportTask): string {
    if (task.status) {
        return STATUS_LABELS[task.status];
    }
    return task.deliverable ? DELIVERABLE_LABELS[task.deliverable.status] : '未交付';
}

function describeEvidence(item: Evidence): string {
    switch (item.type) {
        case 'command':
            return `${code(item.run)}（${item.exit === null ? '未正常结束' : `退出码${item.exit}`}）`;
        case 'diff':
            return item.ref ? `diff ${code(item.ref)}` : 'diff';
        case 'screenshot':
            return `截图${code(item.path)}`;
        case 'note':
            return `说明：${oneLine(item.text)}`;
    }
}

function convert(
    amount: number,
    from: string,
    to: string,
    rates: Readonly<Record<string, number>>,
): number | undefined {
    if (from === to) {
        return amount;
    }
    const direct = rates[`${from}_${to}`];
    if (direct !== undefined && direct > 0) {
        return amount * direct;
    }
    const inverse = rates[`${to}_${from}`];
    return inverse !== undefined && inverse > 0 ? amount / inverse : undefined;
}

interface CostSummary {
    readonly currency: string;
    readonly total: number;
    readonly byTier: ReadonlyMap<string, number>;
    readonly byAgent: ReadonlyMap<string, { cost: number; role?: string; tiers: Set<string> }>;
    readonly supervisor: number;
    /** Costs that could not be converted, by currency. */
    readonly unconverted: ReadonlyMap<string, number>;
}

function summarizeCosts(input: DeliveryReportInput): CostSummary {
    const currency = input.currency ?? input.usage.find((usage) => usage.cost)?.cost?.currency ?? 'CNY';
    const byTier = new Map<string, number>();
    const byAgent = new Map<string, { cost: number; role?: string; tiers: Set<string> }>();
    const unconverted = new Map<string, number>();
    let total = 0;
    let supervisor = 0;
    for (const usage of input.usage) {
        if (!usage.cost || !Number.isFinite(usage.cost.amount)) {
            continue;
        }
        const amount = convert(usage.cost.amount, usage.cost.currency, currency, input.rates ?? {});
        if (amount === undefined) {
            unconverted.set(usage.cost.currency, (unconverted.get(usage.cost.currency) ?? 0) + usage.cost.amount);
            continue;
        }
        total += amount;
        const tier = usage.tier ?? UNKNOWN;
        byTier.set(tier, (byTier.get(tier) ?? 0) + amount);
        const agentId = usage.agentId ?? UNKNOWN;
        const agent = byAgent.get(agentId) ?? { cost: 0, role: usage.role, tiers: new Set<string>() };
        agent.cost += amount;
        agent.role ??= usage.role;
        if (usage.tier) {
            agent.tiers.add(usage.tier);
        }
        byAgent.set(agentId, agent);
        if (usage.role === 'supervisor') {
            supervisor += amount;
        }
    }
    return { currency, total, byTier, byAgent, supervisor, unconverted };
}

function tierLabel(tier: string): string {
    return (TIER_LABELS as Readonly<Record<string, string>>)[tier] ?? tier;
}

function roleLabel(role: string | undefined): string {
    if (role === undefined) {
        return UNKNOWN;
    }
    return (ROLES as readonly string[]).includes(role) ? ROLE_LABELS[role as Role] : role;
}

function share(amount: number, total: number): string {
    return total > 0 ? percent(amount / total) : '-';
}

function costSection(costs: CostSummary): string[] {
    const lines = ['## 花费明细', ''];
    const extra = [...costs.unconverted].map(([currency, amount]) => money(amount, currency));
    lines.push(
        `合计：${money(costs.total, costs.currency)}${extra.length > 0 ? `，另有${extra.join('、')}未换算` : ''}。`,
    );
    if (costs.byTier.size === 0) {
        return lines;
    }
    const tierRows = [...costs.byTier].sort(([a], [b]) => tierPosition(a) - tierPosition(b));
    lines.push('', '| 档位 | 花费 | 占比 |', '|---|---|---|');
    for (const [tier, amount] of tierRows) {
        lines.push(`| ${cell(tierLabel(tier))} | ${money(amount, costs.currency)} | ${share(amount, costs.total)} |`);
    }
    const agentRows = [...costs.byAgent].sort(([, a], [, b]) => b.cost - a.cost);
    lines.push('', '| agent | 角色 | 档位 | 花费 | 占比 |', '|---|---|---|---|---|');
    for (const [agentId, agent] of agentRows) {
        const tiers = [...agent.tiers].sort((a, b) => tierPosition(a) - tierPosition(b)).map(tierLabel);
        lines.push(
            `| ${cell(agentId)} | ${cell(roleLabel(agent.role))} | ${cell(tiers.join('、') || UNKNOWN)} | ` +
                `${money(agent.cost, costs.currency)} | ${share(agent.cost, costs.total)} |`,
        );
    }
    return lines;
}

/** Strongest tier first, unknown tiers last. */
function tierPosition(tier: string): number {
    const index = TIER_ORDER.indexOf(tier as Tier);
    return index < 0 ? -1 : TIER_ORDER.length - index;
}

function supervisionSection(costs: CostSummary, alertRatio: number): string[] {
    const lines = ['## 监督开销', ''];
    if (costs.total <= 0) {
        lines.push('还没有花费记录。');
        return lines;
    }
    const ratio = costs.supervisor / costs.total;
    const head = `主管花费${money(costs.supervisor, costs.currency)}，占总花费的${percent(ratio)}`;
    lines.push(
        ratio > alertRatio
            ? `${head}，超过提示线${percent(alertRatio)}：任务可能拆得太碎，或者来回沟通太多。`
            : `${head}，在提示线${percent(alertRatio)}以内。`,
    );
    return lines;
}

/** The delivery report as markdown. */
export function deliveryReport(input: DeliveryReportInput): string {
    const delivered = new Map<string, Deliverable>();
    for (const deliverable of input.deliverables ?? []) {
        delivered.set(deliverable.taskId, deliverable);
    }
    const tasks: ReportTask[] = input.cards.map((item) => {
        if ('card' in item) {
            return {
                card: item.card,
                status: item.status,
                retries: item.attempts.filter((attempt) => attempt.outcome !== 'pass').length,
                deliverable: delivered.get(item.card.id) ?? item.deliverable,
                note: item.note,
            };
        }
        return { card: item, retries: 0, deliverable: delivered.get(item.id) };
    });

    const lines = ['# 交付报告', '', `目标：${oneLine(input.goal)}`, ''];
    const done = tasks.filter((task) => (task.status ? task.status === 'done' : task.deliverable?.status === 'done'));
    const counted = (status: TaskStatus): number => tasks.filter((task) => task.status === status).length;
    const tally = [`完成${done.length}/${tasks.length}个任务`];
    if (counted('failed') > 0) {
        tally.push(`失败${counted('failed')}个`);
    }
    if (counted('cancelled') > 0) {
        tally.push(`取消${counted('cancelled')}个`);
    }
    lines.push(`结果：${tally.join('，')}。`, '');

    lines.push('## 做了什么', '');
    for (const task of tasks) {
        const retried = task.retries > 0 ? `，退回或升级${task.retries}次` : '';
        const summary = task.deliverable ? `：${oneLine(task.deliverable.summary)}` : '';
        lines.push(`- **${task.card.id} ${oneLine(task.card.title)}**（${statusLabel(task)}${retried}）${summary}`);
        const changes = task.deliverable?.changes ?? [];
        if (changes.length > 0) {
            lines.push(
                `  - 改动：${changes.map((change) => `${code(change.file)}（${CHANGE_LABELS[change.kind]}）`).join('、')}`,
            );
        }
    }
    const decisions = input.ledger?.decisions ?? [];
    if (decisions.length > 0) {
        lines.push('', '关键决定：', ...decisions.map((decision) => `- ${oneLine(decision)}`));
    }
    lines.push('');

    lines.push('## 证据', '');
    for (const task of tasks) {
        const evidence = task.deliverable?.evidence ?? [];
        lines.push(
            `- ${task.card.id}：${evidence.length > 0 ? evidence.map(describeEvidence).join('；') : '没有证据'}`,
        );
    }
    lines.push('');

    const costs = summarizeCosts(input);
    lines.push(...costSection(costs), '');
    lines.push(...supervisionSection(costs, input.alertRatio ?? DEFAULT_SUPERVISION_ALERT_RATIO), '');

    lines.push('## 遗留问题', '');
    const open: string[] = [];
    for (const task of tasks) {
        const finished = task.status
            ? task.status === 'done' || task.status === 'cancelled'
            : task.deliverable?.status === 'done';
        if (!finished) {
            const note = task.note ? `：${oneLine(task.note)}` : '';
            open.push(`${task.card.id}没有完成（${statusLabel(task)}）${note}`);
        }
        for (const risk of task.deliverable?.risks ?? []) {
            open.push(`${task.card.id}的风险：${oneLine(risk)}`);
        }
        for (const question of task.deliverable?.openQuestions ?? []) {
            open.push(`${task.card.id}待解答：${oneLine(question)}`);
        }
    }
    for (const risk of input.ledger?.risks ?? []) {
        open.push(`计划中的风险：${oneLine(risk)}`);
    }
    lines.push(...(open.length > 0 ? [...new Set(open)].map((item) => `- ${item}`) : ['没有遗留问题。']));

    return `${zhStyle(lines.join('\n'))}\n`;
}
