import { bilingual, type UiLanguage } from '@xora/protocol/language';
import type { BoardTask, TaskStatus } from './board.ts';
import type { TaskLedgerContent } from './ledgers.ts';
import { DEFAULT_SUPERVISION_ALERT_RATIO, ROLES, type Role } from './org.ts';
import { TIER_ORDER } from './routing.ts';
import type { ChangeKind, Deliverable, DeliverableStatus, Evidence, TaskCard, Tier } from './schemas.ts';
import { money, percent, roleLabel, tierLabel, uiStyle } from './style.ts';

/**
 * The delivery report (06 §5 ⑪, §13): what was done, the evidence, cost by tier and agent, the supervision
 * overhead and open issues, as markdown in the run's language (Chinese in the user's style).
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
    readonly language: UiLanguage;
}

const TEXT = bilingual(
    {
        statuses: {
            pending: '待开始',
            ready: '待派工',
            assigned: '已派工',
            in_progress: '进行中',
            in_review: '验收中',
            done: '已完成',
            failed: '失败',
            blocked: '受阻',
            cancelled: '已取消',
        } as Readonly<Record<TaskStatus, string>>,
        deliverables: {
            done: '执行者报告完成',
            partial: '部分完成',
            blocked: '受阻',
            escalate: '已升级',
        } as Readonly<Record<DeliverableStatus, string>>,
        changes: { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' } as Readonly<
            Record<ChangeKind, string>
        >,
        unknown: '未知',
        list: '、',
        notDelivered: '未交付',
        command: (command: string, exit: number | null) =>
            `${command}（${exit === null ? '未正常结束' : `退出码${exit}`}）`,
        screenshot: (path: string) => `截图${path}`,
        note: (text: string) => `说明：${text}`,
        costTitle: '## 花费明细',
        total: (total: string, unconverted: readonly string[]) =>
            `合计：${total}${unconverted.length > 0 ? `，另有${unconverted.join('、')}未换算` : ''}。`,
        tierTable: '| 档位 | 花费 | 占比 |',
        agentTable: '| agent | 角色 | 档位 | 花费 | 占比 |',
        supervisionTitle: '## 监督开销',
        noCost: '还没有花费记录。',
        supervision: (cost: string, share: string, alert: string, over: boolean) =>
            over
                ? `主管花费${cost}，占总花费的${share}，超过提示线${alert}：任务可能拆得太碎，或者来回沟通太多。`
                : `主管花费${cost}，占总花费的${share}，在提示线${alert}以内。`,
        title: '# 交付报告',
        goal: (goal: string) => `目标：${goal}`,
        done: (done: number, total: number) => `完成${done}/${total}个任务`,
        failed: (count: number) => `失败${count}个`,
        cancelled: (count: number) => `取消${count}个`,
        result: (parts: readonly string[]) => `结果：${parts.join('，')}。`,
        workTitle: '## 做了什么',
        task: (head: string, status: string, retries: number, summary: string | undefined) =>
            `- **${head}**（${status}${retries > 0 ? `，退回或升级${retries}次` : ''}）${summary ? `：${summary}` : ''}`,
        changed: (items: readonly string[]) => `  - 改动：${items.join('、')}`,
        change: (file: string, kind: string) => `${file}（${kind}）`,
        decisions: '关键决定：',
        evidenceTitle: '## 证据',
        evidence: (task: string, items: readonly string[]) =>
            `- ${task}：${items.length > 0 ? items.join('；') : '没有证据'}`,
        openTitle: '## 遗留问题',
        unfinished: (task: string, status: string, note: string | undefined) =>
            `${task}没有完成（${status}）${note ? `：${note}` : ''}`,
        risk: (task: string, risk: string) => `${task}的风险：${risk}`,
        question: (task: string, question: string) => `${task}待解答：${question}`,
        planRisk: (risk: string) => `计划中的风险：${risk}`,
        noOpen: '没有遗留问题。',
    },
    {
        statuses: {
            pending: 'pending',
            ready: 'ready',
            assigned: 'assigned',
            in_progress: 'in progress',
            in_review: 'in review',
            done: 'done',
            failed: 'failed',
            blocked: 'blocked',
            cancelled: 'cancelled',
        },
        deliverables: {
            done: 'reported done by the executor',
            partial: 'partly done',
            blocked: 'blocked',
            escalate: 'escalated',
        },
        changes: { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' },
        unknown: 'unknown',
        list: ', ',
        notDelivered: 'not delivered',
        command: (command, exit) => `${command} (${exit === null ? 'did not finish' : `exit code ${exit}`})`,
        screenshot: (path) => `screenshot ${path}`,
        note: (text) => `note: ${text}`,
        costTitle: '## Cost',
        total: (total, unconverted) =>
            `Total: ${total}${unconverted.length > 0 ? `, plus ${unconverted.join(', ')} not converted` : ''}.`,
        tierTable: '| Tier | Cost | Share |',
        agentTable: '| Agent | Role | Tier | Cost | Share |',
        supervisionTitle: '## Supervision overhead',
        noCost: 'No costs recorded yet.',
        supervision: (cost, share, alert, over) =>
            over
                ? `The supervisor spent ${cost}, ${share} of the total, above the alert line of ${alert}: the tasks may be split too finely, or there is too much back and forth.`
                : `The supervisor spent ${cost}, ${share} of the total, within the alert line of ${alert}.`,
        title: '# Delivery report',
        goal: (goal) => `Goal: ${goal}`,
        done: (done, total) => `${done} of ${total} tasks done`,
        failed: (count) => `${count} failed`,
        cancelled: (count) => `${count} cancelled`,
        result: (parts) => `Result: ${parts.join(', ')}.`,
        workTitle: '## What was done',
        task: (head, status, retries, summary) =>
            `- **${head}** (${status}${retries > 0 ? `, sent back or escalated ${retries} ${retries === 1 ? 'time' : 'times'}` : ''})${summary ? `: ${summary}` : ''}`,
        changed: (items) => `  - Changes: ${items.join(', ')}`,
        change: (file, kind) => `${file} (${kind})`,
        decisions: 'Key decisions:',
        evidenceTitle: '## Evidence',
        evidence: (task, items) => `- ${task}: ${items.length > 0 ? items.join('; ') : 'no evidence'}`,
        openTitle: '## Open issues',
        unfinished: (task, status, note) => `${task} is not finished (${status})${note ? `: ${note}` : ''}`,
        risk: (task, risk) => `Risk in ${task}: ${risk}`,
        question: (task, question) => `Open question in ${task}: ${question}`,
        planRisk: (risk) => `Risk from the plan: ${risk}`,
        noOpen: 'No open issues.',
    },
);

type ReportText = (typeof TEXT)['zh-CN'];

/** Tier and agent of usage that names none. */
const UNKNOWN = '';

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

function statusLabel(task: ReportTask, text: ReportText): string {
    if (task.status) {
        return text.statuses[task.status];
    }
    return task.deliverable ? text.deliverables[task.deliverable.status] : text.notDelivered;
}

function describeEvidence(item: Evidence, text: ReportText): string {
    switch (item.type) {
        case 'command':
            return text.command(code(item.run), item.exit);
        case 'diff':
            return item.ref ? `diff ${code(item.ref)}` : 'diff';
        case 'screenshot':
            return text.screenshot(code(item.path));
        case 'note':
            return text.note(oneLine(item.text));
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

function tierName(tier: string, language: UiLanguage): string {
    if (tier === UNKNOWN) {
        return TEXT[language].unknown;
    }
    return (TIER_ORDER as readonly string[]).includes(tier) ? tierLabel(tier as Tier, language) : tier;
}

function roleName(role: string | undefined, language: UiLanguage): string {
    if (role === undefined) {
        return TEXT[language].unknown;
    }
    return (ROLES as readonly string[]).includes(role) ? roleLabel(role as Role, language) : role;
}

function share(amount: number, total: number): string {
    return total > 0 ? percent(amount / total) : '-';
}

function costSection(costs: CostSummary, language: UiLanguage): string[] {
    const text = TEXT[language];
    const lines = [text.costTitle, ''];
    const extra = [...costs.unconverted].map(([currency, amount]) => money(amount, currency, language));
    lines.push(text.total(money(costs.total, costs.currency, language), extra));
    if (costs.byTier.size === 0) {
        return lines;
    }
    const tierRows = [...costs.byTier].sort(([a], [b]) => tierPosition(a) - tierPosition(b));
    lines.push('', text.tierTable, '|---|---|---|');
    for (const [tier, amount] of tierRows) {
        lines.push(
            `| ${cell(tierName(tier, language))} | ${money(amount, costs.currency, language)} | ${share(amount, costs.total)} |`,
        );
    }
    const agentRows = [...costs.byAgent].sort(([, a], [, b]) => b.cost - a.cost);
    lines.push('', text.agentTable, '|---|---|---|---|---|');
    for (const [agentId, agent] of agentRows) {
        const tiers = [...agent.tiers]
            .sort((a, b) => tierPosition(a) - tierPosition(b))
            .map((tier) => tierName(tier, language));
        lines.push(
            `| ${cell(agentId === UNKNOWN ? text.unknown : agentId)} | ${cell(roleName(agent.role, language))} | ` +
                `${cell(tiers.join(text.list) || text.unknown)} | ` +
                `${money(agent.cost, costs.currency, language)} | ${share(agent.cost, costs.total)} |`,
        );
    }
    return lines;
}

/** Strongest tier first, unknown tiers last. */
function tierPosition(tier: string): number {
    const index = TIER_ORDER.indexOf(tier as Tier);
    return index < 0 ? -1 : TIER_ORDER.length - index;
}

function supervisionSection(costs: CostSummary, alertRatio: number, language: UiLanguage): string[] {
    const text = TEXT[language];
    const lines = [text.supervisionTitle, ''];
    if (costs.total <= 0) {
        lines.push(text.noCost);
        return lines;
    }
    const ratio = costs.supervisor / costs.total;
    lines.push(
        text.supervision(
            money(costs.supervisor, costs.currency, language),
            percent(ratio),
            percent(alertRatio),
            ratio > alertRatio,
        ),
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

    const { language } = input;
    const text = TEXT[language];
    const lines = [text.title, '', text.goal(oneLine(input.goal)), ''];
    const done = tasks.filter((task) => (task.status ? task.status === 'done' : task.deliverable?.status === 'done'));
    const counted = (status: TaskStatus): number => tasks.filter((task) => task.status === status).length;
    const tally = [text.done(done.length, tasks.length)];
    if (counted('failed') > 0) {
        tally.push(text.failed(counted('failed')));
    }
    if (counted('cancelled') > 0) {
        tally.push(text.cancelled(counted('cancelled')));
    }
    lines.push(text.result(tally), '');

    lines.push(text.workTitle, '');
    for (const task of tasks) {
        const summary = task.deliverable ? oneLine(task.deliverable.summary) : undefined;
        lines.push(
            text.task(`${task.card.id} ${oneLine(task.card.title)}`, statusLabel(task, text), task.retries, summary),
        );
        const changes = task.deliverable?.changes ?? [];
        if (changes.length > 0) {
            lines.push(
                text.changed(changes.map((change) => text.change(code(change.file), text.changes[change.kind]))),
            );
        }
    }
    const decisions = input.ledger?.decisions ?? [];
    if (decisions.length > 0) {
        lines.push('', text.decisions, ...decisions.map((decision) => `- ${oneLine(decision)}`));
    }
    lines.push('');

    lines.push(text.evidenceTitle, '');
    for (const task of tasks) {
        const evidence = task.deliverable?.evidence ?? [];
        lines.push(
            text.evidence(
                task.card.id,
                evidence.map((item) => describeEvidence(item, text)),
            ),
        );
    }
    lines.push('');

    const costs = summarizeCosts(input);
    lines.push(...costSection(costs, language), '');
    lines.push(...supervisionSection(costs, input.alertRatio ?? DEFAULT_SUPERVISION_ALERT_RATIO, language), '');

    lines.push(text.openTitle, '');
    const open: string[] = [];
    for (const task of tasks) {
        const finished = task.status
            ? task.status === 'done' || task.status === 'cancelled'
            : task.deliverable?.status === 'done';
        if (!finished) {
            open.push(
                text.unfinished(task.card.id, statusLabel(task, text), task.note ? oneLine(task.note) : undefined),
            );
        }
        for (const risk of task.deliverable?.risks ?? []) {
            open.push(text.risk(task.card.id, oneLine(risk)));
        }
        for (const question of task.deliverable?.openQuestions ?? []) {
            open.push(text.question(task.card.id, oneLine(question)));
        }
    }
    for (const risk of input.ledger?.risks ?? []) {
        open.push(text.planRisk(oneLine(risk)));
    }
    lines.push(...(open.length > 0 ? [...new Set(open)].map((item) => `- ${item}`) : [text.noOpen]));

    return `${uiStyle(lines.join('\n'), language)}\n`;
}
