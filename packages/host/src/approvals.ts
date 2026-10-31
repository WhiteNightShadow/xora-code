import type { Approval, ApprovalDecision, PermissionMode, Rule } from '@xora/protocol';
import { RpcError, RpcErrorCode } from '@xora/protocol';
import type { XoraDatabase } from '@xora/storage';
import type { Bus } from './bus.ts';
import { newId } from './ids.ts';
import { type CallFacts, decide, type PolicyResult, rulePattern, sessionKey } from './policy.ts';

/** Pending approvals expire so a forgotten card cannot be answered days later with stale context. */
const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;

export interface ApprovalOutcome {
    readonly status: 'allowed' | 'denied' | 'expired' | 'cancelled';
    readonly decision?: ApprovalDecision;
    readonly message?: string;
}

interface Pending {
    readonly approval: Approval;
    readonly facts: CallFacts;
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
        });
    }

    list(): Approval[] {
        return [...this.#pending.values()].map((pending) => pending.approval);
    }

    pendingFor(threadId: string): number {
        return [...this.#pending.values()].filter((pending) => pending.approval.threadId === threadId).length;
    }

    /** Registers an approval and resolves when the user answers, it expires, or the turn is cancelled. */
    request(
        input: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'alwaysScopes'>,
        facts: CallFacts,
        onCreated: (approval: Approval) => void,
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
            this.#pending.set(approval.id, { approval, facts, resolve, timer });
            onCreated(approval);
            this.#bus.broadcast('approval.requested', { approval });
        });
    }

    respond(approvalId: string, decision: ApprovalDecision, scope?: 'project' | 'global', message?: string): void {
        const pending = this.#pending.get(approvalId);
        if (!pending) {
            throw new RpcError(RpcErrorCode.NotFound, '这个审批已经处理过或已过期');
        }
        const { approval, facts } = pending;
        // A high-risk action is approved one call at a time (06 §8): "for this session" counts as once.
        if (decision === 'allow_session' && !facts.highRisk) {
            const keys = this.#sessionAllows.get(approval.threadId) ?? new Set<string>();
            keys.add(sessionKey(facts));
            this.#sessionAllows.set(approval.threadId, keys);
        } else if (decision === 'allow_always') {
            if (approval.alwaysScopes.length === 0) {
                throw new RpcError(RpcErrorCode.Rejected, '高风险动作、超出工作区或涉及敏感文件的操作不能设为总是允许');
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
        });
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
