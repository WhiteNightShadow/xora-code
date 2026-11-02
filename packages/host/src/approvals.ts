import type { Approval, ApprovalDecision, PermissionMode, Rule } from '@xora/protocol';
import { bilingual, RpcError, RpcErrorCode } from '@xora/protocol';
import type { XoraDatabase } from '@xora/storage';
import type { Bus } from './bus.ts';
import { newId } from './ids.ts';
import { type CallFacts, decide, type PolicyResult, rulePattern, sessionKey } from './policy.ts';
import { hostLanguage, textOf } from './text.ts';

const TEXT = bilingual(
    {
        gone: '这个审批已经处理过或已过期',
        noAlways: '高风险动作、超出工作区或涉及敏感文件的操作不能设为总是允许',
    },
    {
        gone: 'This approval was already answered or has expired',
        noAlways:
            'High-risk actions, actions outside the workspace and actions on sensitive files cannot be set to always allow',
    },
);

/** Pending approvals expire so a forgotten card cannot be answered days later with stale context. */
const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;

export interface ApprovalOutcome {
    readonly status: 'allowed' | 'denied' | 'expired' | 'cancelled';
    readonly decision?: ApprovalDecision;
    readonly message?: string;
    /**
     * Set when the user did not answer the card: the thread's mode changed and a rule or the policy settled the call,
     * or a team's supervisor approved an ordinary command of its member (06 §21).
     */
    readonly decidedBy?: 'rule' | 'policy' | 'supervisor';
}

/** Told of every new approval card with the facts of its call, e.g. for a team to hand it to its supervisor. */
export type ApprovalListener = (approval: Approval, facts: CallFacts) => void;

/**
 * A tool call that follows its thread's mode: what deciding it again takes when the mode changes while it waits
 * (see {@link ApprovalService.reconsider}).
 */
export interface FollowsMode {
    readonly projectId: string;
    readonly projectRoot: string;
    /** A PreToolUse hook asked for this confirmation: a new mode may still refuse the call, never allow it. */
    readonly hookAsked?: boolean;
}

interface Pending {
    readonly approval: Approval;
    readonly facts: CallFacts;
    readonly follows?: FollowsMode;
    readonly resolve: (outcome: ApprovalOutcome) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

interface RuleRow {
    id: string;
    scope: string;
    project_id: string | null;
    tool: string;
    pattern: string;
    decision: string;
    created_at: number;
    note: string | null;
}

function toRule(row: RuleRow): Rule {
    return {
        id: row.id,
        scope: row.scope === 'project' ? 'project' : 'global',
        ...(row.project_id ? { projectId: row.project_id } : {}),
        tool: row.tool,
        pattern: row.pattern,
        decision: row.decision === 'deny' ? 'deny' : row.decision === 'ask' ? 'ask' : 'allow',
        createdAt: row.created_at,
        ...(row.note ? { note: row.note } : {}),
    };
}

/**
 * The host's side of permissions: evaluates every call against mode and rules, and for "ask" holds the call
 * until the user answers on an approval card (10 §1). Approvals carry one-time ids and expire.
 */
export class ApprovalService {
    readonly #db: XoraDatabase;
    readonly #bus: Bus;
    readonly #pending = new Map<string, Pending>();
    readonly #listeners = new Set<ApprovalListener>();
    /** Per-thread "本会话允许" keys. */
    readonly #sessionAllows = new Map<string, Set<string>>();

    constructor(db: XoraDatabase, bus: Bus) {
        this.#db = db;
        this.#bus = bus;
    }

    rules(): Rule[] {
        return this.#db.all<RuleRow>('select * from rules order by created_at desc').map(toRule);
    }

    removeRule(ruleId: string): void {
        this.#db.run('delete from rules where id = ?', [ruleId]);
    }

    addRule(rule: Omit<Rule, 'id' | 'createdAt'>): Rule {
        const id = newId('r');
        const createdAt = Date.now();
        this.#db.run(
            'insert into rules (id, scope, project_id, tool, pattern, decision, created_at, note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                id,
                rule.scope,
                rule.projectId ?? null,
                rule.tool,
                rule.pattern,
                rule.decision,
                createdAt,
                rule.note ?? null,
            ],
        );
        return { ...rule, id, createdAt };
    }

    evaluate(
        threadId: string,
        facts: CallFacts,
        context: { mode: PermissionMode; projectId: string; projectRoot: string },
    ): PolicyResult {
        return decide(facts, {
            mode: context.mode,
            projectId: context.projectId,
            projectRoot: context.projectRoot,
            rules: this.rules(),
            sessionAllows: this.#sessionAllows.get(threadId) ?? new Set(),
            language: hostLanguage(),
        });
    }

    list(): Approval[] {
        return [...this.#pending.values()].map((pending) => pending.approval);
    }

    /** Whether the card still waits for an answer. */
    isPending(approvalId: string): boolean {
        return this.#pending.has(approvalId);
    }

    /** The facts of a waiting card's call. */
    factsOf(approvalId: string): CallFacts | undefined {
        return this.#pending.get(approvalId)?.facts;
    }

    onRequested(listener: ApprovalListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    pendingFor(threadId: string): number {
        return [...this.#pending.values()].filter((pending) => pending.approval.threadId === threadId).length;
    }

    /**
     * Registers an approval and resolves when the user answers, it expires, or the turn is cancelled. With `follows`
     * a change of the thread's mode can settle it too; the cards of team and workflow runs go without.
     */
    request(
        input: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'alwaysScopes'>,
        facts: CallFacts,
        onCreated: (approval: Approval) => void,
        follows?: FollowsMode,
    ): Promise<ApprovalOutcome> {
        const now = Date.now();
        const approval: Approval = {
            ...input,
            id: newId('a'),
            createdAt: now,
            expiresAt: now + APPROVAL_TTL_MS,
            // Never offer "always" for calls that leave the workspace, touch secrets or are high-risk actions.
            alwaysScopes:
                facts.outside.length > 0 || facts.sensitive.length > 0 || facts.highRisk ? [] : ['project', 'global'],
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.#settle(approval.id, { status: 'expired' }), APPROVAL_TTL_MS);
            this.#pending.set(approval.id, { approval, facts, ...(follows ? { follows } : {}), resolve, timer });
            onCreated(approval);
            this.#bus.broadcast('approval.requested', { approval });
            for (const listener of this.#listeners) {
                try {
                    listener(approval, facts);
                } catch {
                    // A listener's failure leaves the card to the user.
                }
            }
        });
    }

    respond(
        approvalId: string,
        decision: ApprovalDecision,
        scope?: 'project' | 'global',
        message?: string,
        decidedBy?: 'supervisor',
    ): void {
        const pending = this.#pending.get(approvalId);
        if (!pending) {
            throw new RpcError(RpcErrorCode.NotFound, textOf(TEXT).gone);
        }
        const { approval, facts } = pending;
        // A high-risk action is approved one call at a time (06 §8): "for this session" counts as once.
        if (decision === 'allow_session' && !facts.highRisk) {
            const keys = this.#sessionAllows.get(approval.threadId) ?? new Set<string>();
            keys.add(sessionKey(facts));
            this.#sessionAllows.set(approval.threadId, keys);
        } else if (decision === 'allow_always') {
            if (approval.alwaysScopes.length === 0) {
                throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).noAlways);
            }
            const ruleScope = scope ?? 'project';
            this.addRule({
                scope: ruleScope,
                ...(ruleScope === 'project' ? { projectId: approval.projectId } : {}),
                tool: facts.toolName,
                pattern: rulePattern(facts),
                decision: 'allow',
                note: approval.title,
            });
        }
        this.#settle(approvalId, {
            status: decision === 'deny' ? 'denied' : 'allowed',
            decision,
            ...(message ? { message } : {}),
            ...(decidedBy ? { decidedBy } : {}),
        });
    }

    /**
     * The thread's mode changed (10 §2): its waiting tool calls are decided again. What the new mode allows goes
     * ahead once and what it denies is refused with the reason, the way an answer on the card would settle them;
     * the rest keeps waiting. Approvals without `follows` (a team's plan, a workflow's gate or command) stay.
     */
    reconsider(threadId: string, mode: PermissionMode): void {
        for (const { approval, facts, follows } of [...this.#pending.values()]) {
            if (approval.threadId !== threadId || !follows) {
                continue;
            }
            const policy = this.evaluate(threadId, facts, {
                mode,
                projectId: follows.projectId,
                projectRoot: follows.projectRoot,
            });
            const decidedBy = policy.ruleId ? 'rule' : 'policy';
            if (policy.decision === 'deny') {
                this.#settle(approval.id, { status: 'denied', decision: 'deny', message: policy.reason, decidedBy });
            } else if (policy.decision === 'allow' && !follows.hookAsked) {
                this.#settle(approval.id, {
                    status: 'allowed',
                    decision: 'allow_once',
                    message: policy.reason,
                    decidedBy,
                });
            }
        }
    }

    /** Cancels every pending approval of a thread (turn cancelled or failed). */
    cancelThread(threadId: string): void {
        for (const pending of [...this.#pending.values()]) {
            if (pending.approval.threadId === threadId) {
                this.#settle(pending.approval.id, { status: 'cancelled' });
            }
        }
    }

    clearSession(threadId: string): void {
        this.#sessionAllows.delete(threadId);
    }

    #settle(approvalId: string, outcome: ApprovalOutcome): void {
        const pending = this.#pending.get(approvalId);
        if (!pending) {
            return;
        }
        this.#pending.delete(approvalId);
        clearTimeout(pending.timer);
        pending.resolve(outcome);
        this.#bus.broadcast('approval.resolved', { approvalId, status: outcome.status });
    }

    dispose(): void {
        for (const id of [...this.#pending.keys()]) {
            this.#settle(id, { status: 'cancelled' });
        }
    }
}
