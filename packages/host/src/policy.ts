import path from 'node:path';
import type { PermissionMode, Risk, Rule, ToolKind } from '@xora/protocol';
import picomatch from 'picomatch';

/**
 * The permission decision (10 §2–§4). Pure: given the call, the mode and the rules, say allow, ask or deny.
 * The host is the only place this runs; the engine only reports facts about the call.
 */
export interface CallFacts {
    /** xora tool name, or the external agent's tool title. */
    readonly toolName: string;
    readonly kind: ToolKind;
    /** The tool never changes anything (xora metadata; for external agents inferred from `kind`). */
    readonly readOnly: boolean;
    readonly command?: string;
    readonly readOnlyCommand?: boolean;
    /** Absolute paths the call touches. */
    readonly paths: readonly string[];
    readonly outside: readonly string[];
    readonly sensitive: readonly string[];
    readonly external: boolean;
}

export interface PolicyContext {
    readonly mode: PermissionMode;
    readonly projectRoot: string;
    readonly projectId: string;
    readonly rules: readonly Rule[];
    /** `toolName:pattern` keys allowed for this thread with "本会话允许". */
    readonly sessionAllows: ReadonlySet<string>;
}

export type Decision = 'allow' | 'ask' | 'deny';

export interface PolicyResult {
    readonly decision: Decision;
    readonly risks: readonly Risk[];
    readonly reason: string;
    readonly ruleId?: string;
}

const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'delete', 'move']);

export function risksOf(facts: CallFacts): Risk[] {
    const risks = new Set<Risk>();
    if (facts.kind === 'execute') {
        risks.add('execute');
        if (facts.readOnlyCommand !== true) {
            risks.add('unknown_command');
        }
    } else if (!facts.readOnly || WRITE_KINDS.has(facts.kind)) {
        risks.add('write');
    }
    if (facts.kind === 'delete') {
        risks.add('delete');
    }
    if (facts.kind === 'fetch') {
        risks.add('network');
    }
    if (facts.outside.length > 0) {
        risks.add('outside_workspace');
    }
    if (facts.sensitive.length > 0) {
        risks.add('sensitive_file');
    }
    if (facts.external) {
        risks.add('external_agent');
    }
    return [...risks];
}

/** The pattern an "always allow" rule records for this call: a command prefix or `*`. */
export function rulePattern(facts: CallFacts): string {
    if (facts.command) {
        const words = facts.command.trim().split(/\s+/).slice(0, 2);
        return words.join(' ');
    }
    return '*';
}

export function sessionKey(facts: CallFacts): string {
    return `${facts.toolName}:${rulePattern(facts)}`;
}

function ruleMatches(rule: Rule, facts: CallFacts, context: PolicyContext): boolean {
    if (rule.scope === 'project' && rule.projectId !== context.projectId) {
        return false;
    }
    if (rule.tool !== '*' && rule.tool !== facts.toolName) {
        return false;
    }
    if (rule.pattern === '*') {
        return true;
    }
    if (facts.command !== undefined) {
        const command = facts.command.trim();
        return command === rule.pattern || command.startsWith(`${rule.pattern} `);
    }
    if (facts.paths.length === 0) {
        return false;
    }
    const match = picomatch(rule.pattern, { dot: true });
    return facts.paths.every((file) => {
        const relative = path.relative(context.projectRoot, file).split(path.sep).join('/');
        return match(relative) || match(file);
    });
}

function modeDefault(facts: CallFacts, mode: PermissionMode): { decision: Decision; reason: string } {
    if (facts.kind === 'other' && facts.external) {
        // An external agent's action of unknown nature: never assume it is harmless.
        if (mode === 'full') return { decision: 'allow', reason: '全权模式' };
        if (mode === 'plan') return { decision: 'deny', reason: '计划模式不执行未知操作' };
        return { decision: 'ask', reason: '外部agent的未知操作需要确认' };
    }
    const isCommand = facts.kind === 'execute';
    const isWrite = !isCommand && (!facts.readOnly || WRITE_KINDS.has(facts.kind));
    if (isCommand) {
        switch (mode) {
            case 'full':
                return { decision: 'allow', reason: '全权模式' };
            case 'auto_edit':
                return facts.readOnlyCommand
                    ? { decision: 'allow', reason: '只读命令' }
                    : { decision: 'ask', reason: '自动编辑模式下命令需要确认' };
            case 'plan':
                return facts.readOnlyCommand
                    ? { decision: 'allow', reason: '只读命令' }
                    : { decision: 'deny', reason: '计划模式不运行会改动状态的命令' };
            default:
                return { decision: 'ask', reason: '询问模式下命令需要确认' };
        }
    }
    if (facts.kind === 'fetch') {
        return mode === 'full'
            ? { decision: 'allow', reason: '全权模式' }
            : { decision: 'ask', reason: '联网需要确认' };
    }
    if (isWrite) {
        switch (mode) {
            case 'full':
                return { decision: 'allow', reason: '全权模式' };
            case 'auto_edit':
                return { decision: 'allow', reason: '自动编辑模式' };
            case 'plan':
                return { decision: 'deny', reason: '计划模式不修改文件' };
            default:
                return { decision: 'ask', reason: '询问模式下修改文件需要确认' };
        }
    }
    return { decision: 'allow', reason: '只读操作' };
}

export function decide(facts: CallFacts, context: PolicyContext): PolicyResult {
    const risks = risksOf(facts);
    const deny = context.rules.find((rule) => rule.decision === 'deny' && ruleMatches(rule, facts, context));
    if (deny) {
        return { decision: 'deny', risks, reason: '被规则拒绝', ruleId: deny.id };
    }
    // Leaving the workspace or touching secrets is never decided silently (10 §4), in any mode.
    const guarded = facts.outside.length > 0 || facts.sensitive.length > 0;
    const base = modeDefault(facts, context.mode);
    if (guarded) {
        if (context.mode === 'plan' && base.decision === 'deny') {
            return { decision: 'deny', risks, reason: base.reason };
        }
        return {
            decision: 'ask',
            risks,
            reason: facts.sensitive.length > 0 ? '涉及敏感文件' : '超出工作区',
        };
    }
    if (base.decision === 'deny') {
        return { decision: 'deny', risks, reason: base.reason };
    }
    const ask = context.rules.find((rule) => rule.decision === 'ask' && ruleMatches(rule, facts, context));
    if (ask) {
        return { decision: 'ask', risks, reason: '规则要求确认', ruleId: ask.id };
    }
    const allow = context.rules.find((rule) => rule.decision === 'allow' && ruleMatches(rule, facts, context));
    if (allow) {
        return { decision: 'allow', risks, reason: '规则允许', ruleId: allow.id };
    }
    if (context.sessionAllows.has(sessionKey(facts))) {
        return { decision: 'allow', risks, reason: '本会话已允许' };
    }
    return { decision: base.decision, risks, reason: base.reason };
}
