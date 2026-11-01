import path from 'node:path';
import { bilingual, type PermissionMode, type Risk, type Rule, type ToolKind, type UiLanguage } from '@xora/protocol';
import { type HighRisk, type HighRiskAction, highRiskOfCommand, highRiskOfTool } from '@xora/tools';
import { isHighRiskAction } from '@xora/workflows';
import picomatch from 'picomatch';

/**
 * The permission decision (10 §2–§4). Pure: given the call, the mode and the rules, say allow, ask or deny, and why
 * in the UI language.
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
    /** A high-risk action (06 §8) in a thread whose high-risk actions a person approves; see {@link highRiskOf}. */
    readonly highRisk?: HighRisk;
}

export interface PolicyContext {
    readonly mode: PermissionMode;
    readonly projectRoot: string;
    readonly projectId: string;
    readonly rules: readonly Rule[];
    /** `toolName:pattern` keys allowed for this thread with "allow for this session". */
    readonly sessionAllows: ReadonlySet<string>;
    /** Language of the reason. */
    readonly language: UiLanguage;
}

export type Decision = 'allow' | 'ask' | 'deny';

export interface PolicyResult {
    readonly decision: Decision;
    readonly risks: readonly Risk[];
    readonly reason: string;
    readonly ruleId?: string;
}

const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'delete', 'move']);

const TEXT = bilingual(
    {
        highRisk: {
            push: '推送',
            publish: '发布',
            delete: '删除',
            external_message: '对外发消息',
            payment: '付款',
        } as Readonly<Record<HighRiskAction, string>>,
        full: '全权模式',
        planUnknown: '计划模式不执行未知操作',
        externalUnknown: '外部agent的未知操作需要确认',
        readOnlyCommand: '只读命令',
        autoEditCommand: '自动编辑模式下命令需要确认',
        planCommand: '计划模式不运行会改动状态的命令',
        askCommand: '询问模式下命令需要确认',
        fetch: '联网需要确认',
        autoEdit: '自动编辑模式',
        planWrite: '计划模式不修改文件',
        askWrite: '询问模式下修改文件需要确认',
        readOnly: '只读操作',
        ruleDeny: '被规则拒绝',
        sensitive: '涉及敏感文件',
        outside: '超出工作区',
        highRiskAsk: (action: string) => `高风险动作（${action}）要你确认`,
        ruleAsk: '规则要求确认',
        ruleAllow: '规则允许',
        sessionAllow: '本会话已允许',
    },
    {
        highRisk: {
            push: 'push',
            publish: 'publish',
            delete: 'delete',
            external_message: 'message outside',
            payment: 'payment',
        },
        full: 'Full access mode',
        planUnknown: 'Plan mode does not run unknown actions',
        externalUnknown: 'Unknown actions of an external agent need your approval',
        readOnlyCommand: 'Read-only command',
        autoEditCommand: 'Commands need your approval in auto edit mode',
        planCommand: 'Plan mode does not run commands that change things',
        askCommand: 'Commands need your approval in ask mode',
        fetch: 'Network access needs your approval',
        autoEdit: 'Auto edit mode',
        planWrite: 'Plan mode does not change files',
        askWrite: 'File changes need your approval in ask mode',
        readOnly: 'Read-only action',
        ruleDeny: 'Denied by a rule',
        sensitive: 'Touches sensitive files',
        outside: 'Outside the workspace',
        highRiskAsk: (action) => `High-risk action (${action}): needs your approval`,
        ruleAsk: 'A rule asks for approval',
        ruleAllow: 'Allowed by a rule',
        sessionAllow: 'Allowed for this session',
    },
);

/** How approval cards name a high-risk action. */
export function highRiskLabel(action: HighRiskAction, language: UiLanguage): string {
    return TEXT[language].highRisk[action];
}

/**
 * The high-risk action of a call (06 §8): a shell command by what it runs, an MCP tool by its name. `roots` are the
 * folders the agent works in; deleting outside them, or one of them as a whole, is high risk.
 */
export function highRiskOf(
    call: { readonly toolName: string; readonly command?: string | undefined },
    where: { readonly cwd: string; readonly roots?: readonly string[] },
): HighRisk | undefined {
    const found =
        call.command !== undefined
            ? highRiskOfCommand(call.command, { cwd: where.cwd, roots: where.roots ?? [where.cwd] })
            : highRiskOfTool(call.toolName);
    return found && isHighRiskAction(found.action) ? found : undefined;
}

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
    if (facts.highRisk) {
        risks.add(facts.highRisk.action === 'delete' ? 'delete' : 'network');
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

function modeDefault(
    facts: CallFacts,
    mode: PermissionMode,
    language: UiLanguage,
): { decision: Decision; reason: string } {
    const text = TEXT[language];
    if (facts.kind === 'other' && facts.external) {
        // An external agent's action of unknown nature: never assume it is harmless.
        if (mode === 'full') return { decision: 'allow', reason: text.full };
        if (mode === 'plan') return { decision: 'deny', reason: text.planUnknown };
        return { decision: 'ask', reason: text.externalUnknown };
    }
    const isCommand = facts.kind === 'execute';
    const isWrite = !isCommand && (!facts.readOnly || WRITE_KINDS.has(facts.kind));
    if (isCommand) {
        switch (mode) {
            case 'full':
                return { decision: 'allow', reason: text.full };
            case 'auto_edit':
                return facts.readOnlyCommand
                    ? { decision: 'allow', reason: text.readOnlyCommand }
                    : { decision: 'ask', reason: text.autoEditCommand };
            case 'plan':
                return facts.readOnlyCommand
                    ? { decision: 'allow', reason: text.readOnlyCommand }
                    : { decision: 'deny', reason: text.planCommand };
            default:
                // Looking around (`ls`, `git status`) changes nothing: only the other commands wait for the user.
                return facts.readOnlyCommand
                    ? { decision: 'allow', reason: text.readOnlyCommand }
                    : { decision: 'ask', reason: text.askCommand };
        }
    }
    if (facts.kind === 'fetch') {
        return mode === 'full' ? { decision: 'allow', reason: text.full } : { decision: 'ask', reason: text.fetch };
    }
    if (isWrite) {
        switch (mode) {
            case 'full':
                return { decision: 'allow', reason: text.full };
            case 'auto_edit':
                return { decision: 'allow', reason: text.autoEdit };
            case 'plan':
                return { decision: 'deny', reason: text.planWrite };
            default:
                return { decision: 'ask', reason: text.askWrite };
        }
    }
    return { decision: 'allow', reason: text.readOnly };
}

export function decide(facts: CallFacts, context: PolicyContext): PolicyResult {
    const text = TEXT[context.language];
    const risks = risksOf(facts);
    const deny = context.rules.find((rule) => rule.decision === 'deny' && ruleMatches(rule, facts, context));
    if (deny) {
        return { decision: 'deny', risks, reason: text.ruleDeny, ruleId: deny.id };
    }
    // Leaving the workspace or touching secrets is never decided silently (10 §4), in any mode.
    const guarded = facts.outside.length > 0 || facts.sensitive.length > 0;
    const base = modeDefault(facts, context.mode, context.language);
    if (guarded) {
        if (context.mode === 'plan' && base.decision === 'deny') {
            return { decision: 'deny', risks, reason: base.reason };
        }
        return {
            decision: 'ask',
            risks,
            reason: facts.sensitive.length > 0 ? text.sensitive : text.outside,
        };
    }
    if (base.decision === 'deny') {
        return { decision: 'deny', risks, reason: base.reason };
    }
    // A high-risk action always waits for a person (06 §8): no rule, session allowance or mode settles it.
    if (facts.highRisk) {
        return { decision: 'ask', risks, reason: text.highRiskAsk(text.highRisk[facts.highRisk.action]) };
    }
    const ask = context.rules.find((rule) => rule.decision === 'ask' && ruleMatches(rule, facts, context));
    if (ask) {
        return { decision: 'ask', risks, reason: text.ruleAsk, ruleId: ask.id };
    }
    const allow = context.rules.find((rule) => rule.decision === 'allow' && ruleMatches(rule, facts, context));
    if (allow) {
        return { decision: 'allow', risks, reason: text.ruleAllow, ruleId: allow.id };
    }
    if (context.sessionAllows.has(sessionKey(facts))) {
        return { decision: 'allow', risks, reason: text.sessionAllow };
    }
    return { decision: base.decision, risks, reason: base.reason };
}
