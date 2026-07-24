import type {
    AgentToolAction,
    AgentToolPresentation,
    AgentToolSource,
    RuntimeSnapshot,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import type { TranscriptEntry } from './agent-view-model';
import { agentModelDisplayName } from './agent-model-options';

type ToolTitleSource = Pick<ToolCallEvent,
    'title' | 'toolCallId' | 'toolName' | 'toolKind' | 'toolNamespace' | 'presentation' | 'locations' | 'input'>;

export type AgentActivityFilter = 'all' | 'files' | 'search' | 'terminal' | 'web' | 'agent' | 'skill' | 'mcp' | 'plugin' | 'other';

export interface AgentToolDisplay {
    action: AgentToolAction;
    source: AgentToolSource;
    filter: Exclude<AgentActivityFilter, 'all'>;
    badgeLabel: string;
    title: string;
    detailLabel?: string;
    iconClass: string;
    tone: string;
    readOnly?: boolean;
}

export interface AgentContextSummary {
    messageCount: number;
    toolCount: number;
    changedFileCount: number;
    currentModelId?: string;
    currentModelName: string;
    contextWindow?: number;
    totalTokens?: number;
    usagePercent?: number;
    compactionStatus: 'idle' | 'running' | 'failed' | 'cancelled';
    compactionCount: number;
    lastCompaction?: {
        tokensBefore?: number;
        tokensAfter: number;
        elapsedMs?: number;
    };
}

const SESSION_STATUS_LABELS: Record<SessionRecord['status'], string> = {
    idle: '就绪',
    running: '进行中',
    completed: '已完成',
    cancelled: '已取消',
    failed: '失败',
    // Legacy/invalidation state: opening or sending transparently attaches a
    // fresh ACP session while retaining the local transcript.
    'read-only': '可继续'
};

interface ToolPresentation {
    label: string;
    showBasename?: boolean;
}

/**
 * Maps ACP tool kinds to stable, non-sensitive UI labels.  In particular, a
 * terminal title must never echo its command and a network title must never
 * echo its URL or credentials.
 */
const TOOL_PRESENTATIONS: Array<[RegExp, ToolPresentation]> = [
    [/(?:^|[\/.:_-])(?:delete|remove|unlink)(?:$|[\/.:_-])/, { label: '删除文件', showBasename: true }],
    [/(?:^|[\/.:_-])(?:rename|move)(?:$|[\/.:_-])/, { label: '移动文件', showBasename: true }],
    [/(?:^|[\/.:_-])(?:create|new_file)(?:$|[\/.:_-])/, { label: '创建文件', showBasename: true }],
    [/(?:^|[\/.:_-])(?:edit|write|replace|patch|apply_patch)(?:$|[\/.:_-])/, { label: '修改文件', showBasename: true }],
    [/(?:^|[\/.:_-])(?:read_directory|list_directory|directory_list|list_files)(?:$|[\/.:_-])/, { label: '查看目录', showBasename: true }],
    [/(?:^|[\/.:_-])(?:read|read_file|open_file|view_file)(?:$|[\/.:_-])/, { label: '读取文件', showBasename: true }],
    [/(?:^|[\/.:_-])(?:search|grep|find|glob|ripgrep)(?:$|[\/.:_-])/, { label: '搜索项目' }],
    [/(?:^|[\/.:_-])(?:test|tests|run_tests)(?:$|[\/.:_-])/, { label: '运行测试' }],
    [/(?:^|[\/.:_-])(?:terminal|shell|exec|execute|execute_command|run_command|command)(?:$|[\/.:_-])/, { label: '运行命令' }],
    [/(?:^|[\/.:_-])mcp(?:$|[\/.:_-])/, { label: '调用 MCP 工具' }],
    [/(?:^|[\/.:_-])(?:browser|web|fetch|http|request)(?:$|[\/.:_-])/, { label: '访问网络' }],
    [/(?:^|[\/.:_-])skill(?:$|[\/.:_-])/, { label: '使用技能' }],
    [/(?:^|[\/.:_-])plugins?(?:$|[\/.:_-])/, { label: '操作插件' }],
    [/(?:^|[\/.:_-])(?:plan|todo)(?:$|[\/.:_-])/, { label: '更新计划' }]
];

const ACTION_DISPLAYS: Record<AgentToolAction, {
    label: string;
    badge: string;
    iconClass: string;
    tone: string;
    filter: Exclude<AgentActivityFilter, 'all'>;
}> = {
    'file-read': { label: '读取文件', badge: '文件', iconClass: 'codicon-file', tone: 'file', filter: 'files' },
    'file-create': { label: '创建文件', badge: '文件', iconClass: 'codicon-new-file', tone: 'file-write', filter: 'files' },
    'file-write': { label: '修改文件', badge: '文件', iconClass: 'codicon-edit', tone: 'file-write', filter: 'files' },
    'file-delete': { label: '删除文件', badge: '文件', iconClass: 'codicon-trash', tone: 'danger', filter: 'files' },
    'file-move': { label: '移动文件', badge: '文件', iconClass: 'codicon-arrow-swap', tone: 'file-write', filter: 'files' },
    'project-search': { label: '搜索项目', badge: '搜索', iconClass: 'codicon-search', tone: 'search', filter: 'search' },
    'web-search': { label: '搜索互联网', badge: '网络', iconClass: 'codicon-globe', tone: 'web', filter: 'web' },
    'web-fetch': { label: '访问网页', badge: '网络', iconClass: 'codicon-globe', tone: 'web', filter: 'web' },
    terminal: { label: '运行命令', badge: '终端', iconClass: 'codicon-terminal', tone: 'terminal', filter: 'terminal' },
    test: { label: '运行测试', badge: '测试', iconClass: 'codicon-beaker', tone: 'test', filter: 'terminal' },
    browser: { label: '操作浏览器', badge: '网络', iconClass: 'codicon-browser', tone: 'web', filter: 'web' },
    plan: { label: '更新计划', badge: '规划', iconClass: 'codicon-checklist', tone: 'plan', filter: 'other' },
    subagent: { label: '运行子 Agent', badge: 'Agent', iconClass: 'codicon-organization', tone: 'agent', filter: 'agent' },
    other: { label: '执行工具', badge: '工具', iconClass: 'codicon-tools', tone: 'other', filter: 'other' }
};

/** Returns whether a title is an opaque ACP/tool identifier rather than user-facing copy. */
export function isMachineToolTitle(title: string | undefined, toolCallId?: string): boolean {
    const value = title?.trim();
    if (!value) return true;
    if (toolCallId && value === toolCallId.trim()) return true;
    return /^(?:call|tool(?:[-_:]?call)?|request|operation)[-_:][a-z0-9][a-z0-9._:-]{3,}$/i.test(value)
        || /^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(value)
        || /^[0-9a-f]{20,}$/i.test(value);
}

/**
 * Produces a concise Chinese tool title without exposing commands, URLs,
 * secrets, or full paths.  Only the basename of recognized file operations is
 * eligible for display.
 */
export function displayToolTitle(tool: ToolTitleSource): string {
    if (tool.presentation) {
        return presentAgentTool(tool).title;
    }
    const toolName = normalizeToolName(tool.toolName);
    const presentation = TOOL_PRESENTATIONS.find(([pattern]) => pattern.test(toolName))?.[1]
        ?? inferToolPresentation(tool.input);
    if (!presentation) {
        return '执行工具';
    }
    if (!presentation.showBasename) {
        return presentation.label;
    }
    const basename = inputBasename(tool.input);
    return basename ? `${presentation.label} · ${basename}` : presentation.label;
}

/**
 * Produces the visible action/source taxonomy used by both conversation cards
 * and the dedicated activity view. New events use backend-normalized metadata;
 * legacy JSONL records fall back to conservative local inference.
 */
export function presentAgentTool(tool: ToolTitleSource): AgentToolDisplay {
    const presentation = tool.presentation ?? legacyToolPresentation(tool);
    const actionDisplay = ACTION_DISPLAYS[presentation.action];
    const target = safeDisplayFragment(presentation.targetLabel);
    const sourceName = safeDisplayFragment(presentation.sourceLabel);
    const operation = safeDisplayFragment(presentation.operationLabel);

    if (presentation.source === 'mcp') {
        return {
            action: presentation.action,
            source: presentation.source,
            filter: 'mcp',
            badgeLabel: 'MCP',
            title: sourceName && operation ? `${sourceName} · ${operation}` : operation ?? sourceName ?? '调用 MCP 工具',
            detailLabel: actionDisplay.label === '执行工具' ? '外部工具调用' : actionDisplay.label,
            iconClass: 'codicon-plug',
            tone: 'mcp',
            readOnly: presentation.readOnly
        };
    }
    if (presentation.source === 'skill') {
        return {
            action: presentation.action,
            source: presentation.source,
            filter: 'skill',
            badgeLabel: '技能',
            title: sourceName ?? target ?? '使用技能',
            detailLabel: sourceName || target ? '执行 Skill 工作流' : undefined,
            iconClass: 'codicon-symbol-method',
            tone: 'skill',
            readOnly: presentation.readOnly
        };
    }
    if (presentation.source === 'plugin') {
        return {
            action: presentation.action,
            source: presentation.source,
            filter: 'plugin',
            badgeLabel: '插件',
            title: sourceName ?? target ?? '插件操作',
            detailLabel: sourceName || target ? '插件提供的能力' : undefined,
            iconClass: 'codicon-extensions',
            tone: 'plugin',
            readOnly: presentation.readOnly
        };
    }
    if (presentation.action === 'subagent') {
        const operation = subagentOperationLabel(tool);
        const task = target ?? subagentTaskLabel(tool.input);
        return {
            action: presentation.action,
            source: presentation.source,
            filter: actionDisplay.filter,
            badgeLabel: actionDisplay.badge,
            title: task ? `${operation} · ${task}` : operation,
            detailLabel: subagentDetailLabel(tool),
            iconClass: actionDisplay.iconClass,
            tone: actionDisplay.tone,
            readOnly: presentation.readOnly
        };
    }
    return {
        action: presentation.action,
        source: presentation.source,
        filter: actionDisplay.filter,
        badgeLabel: actionDisplay.badge,
        title: target ? `${actionDisplay.label} · ${target}` : actionDisplay.label,
        detailLabel: presentation.readOnly ? '只读操作' : undefined,
        iconClass: actionDisplay.iconClass,
        tone: actionDisplay.tone,
        readOnly: presentation.readOnly
    };
}

export function toolMatchesActivityFilter(tool: ToolTitleSource, filter: AgentActivityFilter): boolean {
    if (filter === 'all') return true;
    return activityFiltersForTool(tool).includes(filter);
}

export function activityFiltersForTool(tool: ToolTitleSource): Array<Exclude<AgentActivityFilter, 'all'>> {
    const display = presentAgentTool(tool);
    const filters = [display.filter];
    const actionFilter = ACTION_DISPLAYS[display.action].filter;
    if (display.action !== 'other' && actionFilter !== display.filter) filters.push(actionFilter);
    return filters;
}

export function summarizeToolCategories(tools: readonly ToolTitleSource[]): Array<{
    filter: Exclude<AgentActivityFilter, 'all'>;
    label: string;
    count: number;
}> {
    const counts = new Map<Exclude<AgentActivityFilter, 'all'>, { label: string; count: number }>();
    for (const tool of tools) {
        const display = presentAgentTool(tool);
        const categories = [{ filter: display.filter, label: display.badgeLabel }];
        const action = ACTION_DISPLAYS[display.action];
        if (display.action !== 'other' && action.filter !== display.filter) {
            categories.push({ filter: action.filter, label: action.badge });
        }
        for (const category of categories) {
            const previous = counts.get(category.filter);
            counts.set(category.filter, { label: category.label, count: (previous?.count ?? 0) + 1 });
        }
    }
    return [...counts].map(([filter, value]) => ({ filter, ...value }));
}

export function sessionStatusLabel(status: SessionRecord['status']): string {
    return SESSION_STATUS_LABELS[status];
}

/** Formats a session update time relative to `now`, using stable Chinese copy. */
export function sessionRelativeTime(updatedAt: string, now = Date.now()): string {
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp)) return '时间未知';
    const elapsed = Math.max(0, now - timestamp);
    if (elapsed < 60_000) return '刚刚';
    if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
    if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
    if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`;

    const date = new Date(timestamp);
    const nowDate = new Date(now);
    const prefix = date.getFullYear() === nowDate.getFullYear() ? '' : `${date.getFullYear()}年`;
    return `${prefix}${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Summarizes only information the current ACP snapshot and transcript actually expose. */
export function summarizeAgentContext(snapshot: RuntimeSnapshot, transcript: readonly TranscriptEntry[]): AgentContextSummary {
    const activeSession = snapshot.sessions.find(session => session.appSessionId === snapshot.activeSessionId);
    const context = snapshot.activeSessionId ? snapshot.sessionContexts?.[snapshot.activeSessionId] : undefined;
    const currentModelId = context?.modelId ?? snapshot.selectedModel ?? activeSession?.model;
    const model = currentModelId ? snapshot.models.find(candidate => candidate.id === currentModelId) : undefined;
    const relevantEntries = transcript.filter(entry => belongsToSession(entry, snapshot.activeSessionId));
    const messageCount = relevantEntries.filter(entry =>
        entry.kind === 'user' || entry.kind === 'assistant' || entry.kind === 'system').length;
    const tools = new Set<string>();
    const changedFiles = new Set<string>();

    for (const entry of relevantEntries) {
        if (entry.kind === 'tool') {
            const event = entry.payload?.kind === 'tool-call' ? entry.payload : undefined;
            tools.add(event?.toolCallId ?? entry.id);
        } else if (entry.kind === 'diff' && entry.payload?.kind === 'diff') {
            const normalized = normalizeChangedPath(entry.payload.path);
            if (normalized) changedFiles.add(normalized);
        }
    }

    const contextWindow = positiveFinite(context?.contextWindow) ?? positiveFinite(model?.contextWindow);
    const totalTokens = nonNegativeFinite(context?.totalTokens);
    const usagePercent = nonNegativeFinite(context?.usagePercent)
        ?? (totalTokens !== undefined && contextWindow !== undefined
            ? Math.floor((totalTokens * 100) / contextWindow)
            : undefined);
    return {
        messageCount,
        toolCount: tools.size,
        changedFileCount: changedFiles.size,
        currentModelId,
        currentModelName: currentModelId
            ? agentModelDisplayName(currentModelId, model?.name)
            : '服务默认模型',
        contextWindow,
        totalTokens,
        usagePercent,
        compactionStatus: context?.compactionStatus ?? 'idle',
        compactionCount: context?.compactionCount ?? 0,
        lastCompaction: context?.lastCompaction
    };
}

function legacyToolPresentation(tool: ToolTitleSource): AgentToolPresentation {
    const name = normalizeToolName(tool.toolName);
    const kind = normalizeToolName(tool.toolKind ?? '');
    const identity = `${kind}/${name}`;
    const input = inputRecord(tool.input);
    const mcpParts = parseLegacyMcpName(tool.toolName);
    const source: AgentToolSource = tool.toolNamespace?.toLowerCase() === 'mcp' || !!mcpParts || /(?:^|[\/.:_-])mcp(?:$|[\/.:_-])/.test(identity)
        ? 'mcp'
        : /(?:^|[\/.:_-])plugins?(?:$|[\/.:_-])/.test(identity) || hasInputKey(input, ['plugin', 'plugin_name', 'pluginName'])
            ? 'plugin'
            : /(?:^|[\/.:_-])skills?(?:$|[\/.:_-])/.test(identity) || kind === 'skill'
                ? 'skill'
                : 'builtin';

    let action: AgentToolAction = 'other';
    if (/^(?:read|list|list_dir|memory_get)$/.test(kind)
        || /(?:^|[\/.:_-])(?:read|read_file|open_file|view_file|read_directory|list_directory|list_files)(?:$|[\/.:_-])/.test(identity)) {
        action = 'file-read';
    } else if (kind === 'create'
        || /(?:^|[\/.:_-])(?:create|create_file|new_file)(?:$|[\/.:_-])/.test(identity)) {
        action = 'file-create';
    } else if (/^(?:edit|write)$/.test(kind)
        || /(?:^|[\/.:_-])(?:edit|write|replace|patch|apply_patch)(?:$|[\/.:_-])/.test(identity)) {
        action = 'file-write';
    } else if (kind === 'delete' || /(?:^|[\/.:_-])(?:delete|remove|unlink)(?:$|[\/.:_-])/.test(identity)) {
        action = 'file-delete';
    } else if (kind === 'move' || /(?:^|[\/.:_-])(?:move|rename)(?:$|[\/.:_-])/.test(identity)) {
        action = 'file-move';
    } else if (kind === 'web_search' || /(?:^|[\/.:_-])web_search(?:$|[\/.:_-])/.test(identity)) {
        action = 'web-search';
    } else if (kind === 'web_fetch' || kind === 'fetch' || /(?:^|[\/.:_-])(?:web_fetch|fetch_url)(?:$|[\/.:_-])/.test(identity)) {
        action = 'web-fetch';
    } else if (kind === 'search' || kind === 'lsp'
        || /(?:^|[\/.:_-])(?:search|grep|find|glob|ripgrep)(?:$|[\/.:_-])/.test(identity)) {
        action = 'project-search';
    } else if (kind === 'execute' || /(?:^|[\/.:_-])(?:terminal|shell|exec|execute|execute_command|run_command|command)(?:$|[\/.:_-])/.test(identity)) {
        action = /(?:^|[\/.:_-])(?:test|tests|pytest|jest|vitest)(?:$|[\/.:_-])/.test(identity) ? 'test' : 'terminal';
    } else if (/(?:^|[\/.:_-])(?:browser|playwright|computer_use)(?:$|[\/.:_-])/.test(identity)) {
        action = 'browser';
    } else if (/^(?:plan|enter_plan|exit_plan|goal_update)$/.test(kind)) {
        action = 'plan';
    } else if (/^(?:task|background_task_action|wait_tasks_action|kill_task_action)$/.test(kind)
        || /(?:^|[\/.:_-])(?:spawn_subagent|background_task_action|wait_tasks_action|kill_task_action)(?:$|[\/.:_-])/.test(identity)) {
        action = 'subagent';
    }

    const sourceLabel = source === 'mcp'
        ? mcpParts?.server ?? safeDisplayFragment(inputString(input, ['server', 'server_name', 'mcpServer']))
        : source === 'skill'
            ? safeDisplayFragment(inputString(input, ['skill', 'skill_name', 'skillName', 'name']))
            : source === 'plugin'
                ? safeDisplayFragment(inputString(input, ['plugin', 'plugin_name', 'pluginName', 'name']))
                : undefined;
    const targetLabel = action.startsWith('file-')
        ? inputBasename(tool.input) ?? safeBasename(tool.locations?.[0]?.path ?? '')
        : action === 'project-search'
            ? safeDisplayFragment(inputString(input, ['pattern', 'query', 'symbol']))
            : action === 'web-search'
                ? safeDisplayFragment(inputString(input, ['query', 'search_query', 'q']))
                : action === 'web-fetch' || action === 'browser'
                    ? legacyDomain(inputString(input, ['url', 'uri', 'href', 'endpoint']))
                    : sourceLabel;
    return {
        action,
        source,
        targetLabel,
        sourceLabel,
        operationLabel: source === 'mcp' ? mcpParts?.tool : undefined
    };
}

/**
 * Grok publishes child work through ordinary ACP tool calls. Keep the
 * renderer model Agent-neutral while still distinguishing start, wait and
 * cancel operations in the activity timeline.
 */
function subagentOperationLabel(tool: ToolTitleSource): string {
    const identity = normalizeToolName(`${tool.toolKind ?? ''}/${tool.toolName}`);
    if (/(?:^|[\/.:_-])wait_tasks_action(?:$|[\/.:_-])/.test(identity)) return '等待后台任务';
    if (/(?:^|[\/.:_-])kill_task_action(?:$|[\/.:_-])/.test(identity)) return '停止后台任务';
    if (/(?:^|[\/.:_-])background_task_action(?:$|[\/.:_-])/.test(identity)) return '启动后台任务';
    return '运行子 Agent';
}

function subagentDetailLabel(tool: ToolTitleSource): string | undefined {
    const identity = normalizeToolName(`${tool.toolKind ?? ''}/${tool.toolName}`);
    if (/(?:^|[\/.:_-])wait_tasks_action(?:$|[\/.:_-])/.test(identity)) return '正在汇总子任务结果';
    if (/(?:^|[\/.:_-])kill_task_action(?:$|[\/.:_-])/.test(identity)) return '取消指定的子任务';
    if (/(?:^|[\/.:_-])background_task_action(?:$|[\/.:_-])/.test(identity)) return '后台任务由 Agent Runtime 调度';
    return undefined;
}

function subagentTaskLabel(input: unknown): string | undefined {
    const record = inputRecord(input);
    return safeDisplayFragment(inputString(record, [
        'subagent_type', 'subagentType', 'agent', 'agent_name', 'agentName',
        'description', 'task', 'name'
    ]));
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
    return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function inputString(input: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    for (const key of keys) {
        const candidate = input?.[key];
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    return undefined;
}

function hasInputKey(input: Record<string, unknown> | undefined, keys: string[]): boolean {
    return keys.some(key => typeof input?.[key] === 'string' && !!String(input[key]).trim());
}

function parseLegacyMcpName(value: string): { server: string; tool: string } | undefined {
    const parts = value.split('__').filter(Boolean);
    if (parts[0]?.toLowerCase() === 'mcp') parts.shift();
    if (parts.length < 2) return undefined;
    const server = safeDisplayFragment(parts.shift());
    const tool = safeDisplayFragment(parts.join('__'));
    return server && tool ? { server, tool } : undefined;
}

function legacyDomain(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? safeDisplayFragment(url.hostname) : undefined;
    } catch {
        return undefined;
    }
}

function safeDisplayFragment(value: string | undefined): string | undefined {
    const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized || /\[REDACTED(?:_[A-Z_]+)?\]/.test(normalized)) return undefined;
    return normalized.length > 72 ? `${normalized.slice(0, 71)}…` : normalized;
}

function normalizeToolName(toolName: string): string {
    return toolName
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
}

function inputBasename(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    for (const key of ['path', 'filePath', 'file_path', 'file', 'filename', 'directory']) {
        const candidate = record[key];
        if (typeof candidate !== 'string') continue;
        const basename = safeBasename(candidate);
        if (basename) return basename;
    }
    return undefined;
}

function inferToolPresentation(input: unknown): ToolPresentation | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const keys = new Set(Object.keys(input as Record<string, unknown>).map(key => key.toLowerCase()));
    if (keys.has('command') || keys.has('cmd') || keys.has('script')) return { label: '运行命令' };
    if (keys.has('mcpserver') || keys.has('mcp_server') || keys.has('server')) return { label: '调用 MCP 工具' };
    if (keys.has('url') || keys.has('uri') || keys.has('endpoint')) return { label: '访问网络' };
    if (keys.has('query') || keys.has('pattern') || keys.has('glob')) return { label: '搜索项目' };
    if (['path', 'filepath', 'file_path', 'file', 'filename', 'directory'].some(key => keys.has(key))) {
        return { label: '处理文件', showBasename: true };
    }
    return undefined;
}

function safeBasename(candidate: string): string | undefined {
    const path = candidate.trim().replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const basename = path.slice(path.lastIndexOf('/') + 1).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!basename || basename === '.' || basename === '..') return undefined;
    return basename.length > 64 ? `${basename.slice(0, 61)}…` : basename;
}

function belongsToSession(entry: TranscriptEntry, activeSessionId: string | undefined): boolean {
    if (!activeSessionId || !entry.payload || !('sessionId' in entry.payload)) return true;
    return entry.payload.sessionId === activeSessionId;
}

function normalizeChangedPath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function positiveFinite(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeFinite(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
