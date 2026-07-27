/**
 * Composer `/` command menu — pure detection and filtering helpers.
 * UI wiring lives in the agent widget so IME-safe uncontrolled input is preserved.
 */

export type SlashCommandId = 'file' | 'image' | 'mcp' | 'skill' | 'settings' | 'clear';

export interface SlashCommand {
    readonly id: SlashCommandId;
    /** Primary trigger without leading slash. */
    readonly trigger: string;
    readonly label: string;
    readonly description: string;
    /** Codicon class without the `codicon` prefix, e.g. `file`. */
    readonly icon: string;
    readonly aliases?: readonly string[];
}

export interface SlashQuery {
    /** Inclusive index of the activating `/`. */
    readonly start: number;
    /** Cursor (or end of token) index. */
    readonly end: number;
    /** Text after `/` up to the cursor (no spaces). */
    readonly query: string;
}

export interface SlashMenuItem {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly icon: string;
    readonly kind: 'command' | 'resource' | 'action';
    readonly commandId?: SlashCommandId;
    /** When set, selection inserts this text in place of the `/…` token. */
    readonly insertText?: string;
    /** Secondary action labels (e.g. open management). */
    readonly detail?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
    {
        id: 'file',
        trigger: 'file',
        label: '选择文件',
        description: '从工作区选择文件，插入 @路径 引用',
        icon: 'file',
        aliases: ['f', '文件', 'path']
    },
    {
        id: 'image',
        trigger: 'image',
        label: '添加图片',
        description: '选择图片附件（也支持直接粘贴）',
        icon: 'file-media',
        aliases: ['img', '图片', 'pic']
    },
    {
        id: 'mcp',
        trigger: 'mcp',
        label: 'MCP 服务',
        description: '查看已配置的 MCP，或打开管理页',
        icon: 'server-process',
        aliases: ['m', '工具']
    },
    {
        id: 'skill',
        trigger: 'skill',
        label: '技能 Skill',
        description: '查看可用技能，或打开管理页',
        icon: 'lightbulb',
        aliases: ['skills', 's', '技能']
    },
    {
        id: 'settings',
        trigger: 'settings',
        label: 'Agent 设置',
        description: '打开模型、MCP、技能与插件管理',
        icon: 'settings-gear',
        aliases: ['config', 'manage', '设置', '管理']
    },
    {
        id: 'clear',
        trigger: 'clear',
        label: '清空输入',
        description: '清除当前草稿文本（不影响图片）',
        icon: 'clear-all',
        aliases: ['c', '清空']
    }
];

/**
 * Detect an active `/command` token at the caret.
 * Activates only when `/` is at the start of the draft or follows whitespace,
 * and the token itself contains no spaces (so free-form text is never hijacked).
 */
export function detectSlashQuery(text: string, cursor: number): SlashQuery | undefined {
    if (cursor < 0 || cursor > text.length) return undefined;
    const before = text.slice(0, cursor);
    const slash = before.lastIndexOf('/');
    if (slash < 0) return undefined;
    if (slash > 0) {
        const prev = before.charCodeAt(slash - 1);
        // space, tab, newline, full-width space
        if (prev !== 0x20 && prev !== 0x09 && prev !== 0x0a && prev !== 0x0d && prev !== 0x3000) {
            return undefined;
        }
    }
    const token = before.slice(slash + 1);
    if (/\s/.test(token)) return undefined;
    return { start: slash, end: cursor, query: token };
}

export function filterSlashCommands(query: string): SlashCommand[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter(command => matchesSlashCommand(command, q));
}

export function matchesSlashCommand(command: SlashCommand, queryLower: string): boolean {
    if (command.trigger.startsWith(queryLower) || command.trigger === queryLower) return true;
    if (command.label.toLowerCase().includes(queryLower)) return true;
    return (command.aliases ?? []).some(alias => {
        const a = alias.toLowerCase();
        return a.startsWith(queryLower) || a.includes(queryLower);
    });
}

export function slashCommandsToMenuItems(commands: readonly SlashCommand[]): SlashMenuItem[] {
    return commands.map(command => ({
        key: `cmd:${command.id}`,
        label: `/${command.trigger}`,
        description: command.label,
        icon: command.icon,
        kind: 'command',
        commandId: command.id,
        detail: command.description
    }));
}

export function resourceMenuItems(
    kind: 'mcp' | 'skill',
    entries: ReadonlyArray<{ name: string; detail?: string }>
): SlashMenuItem[] {
    const icon = kind === 'mcp' ? 'server-process' : 'lightbulb';
    const prefix = kind === 'mcp' ? 'MCP' : '技能';
    const items: SlashMenuItem[] = entries.map((entry, index) => ({
        key: `${kind}:${entry.name}:${index}`,
        label: entry.name,
        description: entry.detail ?? prefix,
        icon,
        kind: 'resource',
        insertText: kind === 'mcp'
            ? `（请优先使用 MCP 服务「${entry.name}」）`
            : `（请使用技能「${entry.name}」）`,
        detail: '插入到输入框'
    }));
    items.push({
        key: `${kind}:manage`,
        label: kind === 'mcp' ? '管理 MCP…' : '管理技能…',
        description: '打开 Agent 设置对应页签',
        icon: 'settings-gear',
        kind: 'action',
        commandId: 'settings',
        detail: kind
    });
    return items;
}

/** Replace the active `/…` token with `replacement` (may be empty). */
export function replaceSlashToken(
    text: string,
    query: SlashQuery,
    replacement: string
): { text: string; cursor: number } {
    const before = text.slice(0, query.start);
    const after = text.slice(query.end);
    const needsLeadingSpace = replacement.length > 0
        && before.length > 0
        && !/\s$/.test(before)
        && !replacement.startsWith('\n');
    const needsTrailingSpace = replacement.length > 0
        && after.length > 0
        && !/^\s/.test(after)
        && !replacement.endsWith('\n')
        && !replacement.endsWith(' ');
    const body = `${needsLeadingSpace ? ' ' : ''}${replacement}${needsTrailingSpace ? ' ' : ''}`;
    const next = `${before}${body}${after}`;
    return { text: next, cursor: before.length + body.length };
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, aliases: readonly string[]): string | undefined {
    if (!isJsonObject(value)) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        return undefined;
    }
    const aliasSet = new Set(aliases.map(a => a.replace(/[^a-z0-9]/gi, '').toLowerCase()));
    for (const [key, field] of Object.entries(value)) {
        const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (aliasSet.has(normalized) && typeof field === 'string' && field.trim()) {
            return field.trim();
        }
    }
    return undefined;
}

/**
 * Best-effort extraction of MCP / skill names from management or inspect payloads.
 * Tolerates schema drift from Grok Build management JSON.
 */
export function extractNamedResources(
    data: unknown,
    kind: 'mcp' | 'skill'
): Array<{ name: string; detail?: string }> {
    // Xora's schema-v2 MCP overview deliberately separates discovery,
    // canonical configuration and current-session readiness. A configured,
    // enabled server is selectable in a draft conversation before session/new
    // exists; first send attaches it to ACP. Compatibility-only discoveries
    // remain hidden until explicitly imported into Xora's canonical config.
    if (kind === 'mcp' && isJsonObject(data) && data.schemaVersion === 2 && Array.isArray(data.mcpServers)) {
        return data.mcpServers.flatMap(value => {
            if (!isJsonObject(value) || value.selectable !== true) return [];
            const name = stringField(value, ['name', 'serverName', 'id', 'label']);
            if (!name) return [];
            const runtimeState = stringField(value, ['runtimeState']);
            const detail = runtimeState === 'loaded'
                ? '当前会话已加载'
                : runtimeState === 'initializing'
                    ? '正在连接'
                    : runtimeState === 'reload-required'
                        ? '等待安全刷新'
                        : runtimeState === 'setup-required'
                            ? '需要认证或设置'
                            : runtimeState === 'unavailable'
                                ? '当前不可用'
                                : '发送后自动加载';
            return [detail ? { name, detail } : { name }];
        }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    const names = new Map<string, string | undefined>();
    const nameAliases = kind === 'mcp'
        ? ['name', 'id', 'label', 'serverName', 'mcpName']
        : ['name', 'id', 'label', 'skillName', 'title'];
    const detailAliases = kind === 'mcp'
        ? ['transport', 'status', 'url', 'command', 'scope']
        : ['path', 'skillPath', 'directory', 'scope', 'source', 'description'];
    const containerKeys = kind === 'mcp'
        ? new Set(['mcp', 'servers', 'mcpservers', 'configuredservers', 'connections', 'mcpServers'])
        : new Set(['skill', 'skills', 'effectiveskills', 'discoveredskills', 'availableskills']);

    const visit = (value: unknown, depth: number): void => {
        if (depth > 6 || value === null || value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, depth + 1));
            return;
        }
        if (!isJsonObject(value)) return;
        const name = stringField(value, nameAliases);
        if (name && (looksLikeResource(value, kind) || depth >= 1)) {
            if (!names.has(name)) {
                names.set(name, stringField(value, detailAliases));
            }
        }
        for (const [key, child] of Object.entries(value)) {
            const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (containerKeys.has(normalized) || ['data', 'entries', 'items', 'list', 'result', 'results'].includes(normalized)) {
                visit(child, depth + 1);
            } else if (depth < 3 && child !== null && typeof child === 'object') {
                visit(child, depth + 1);
            }
        }
    };

    visit(data, 0);
    return [...names.entries()]
        .map(([name, detail]) => (detail ? { name, detail } : { name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function looksLikeResource(value: JsonObject, kind: 'mcp' | 'skill'): boolean {
    const keys = Object.keys(value).map(k => k.replace(/[^a-z0-9]/gi, '').toLowerCase());
    if (kind === 'mcp') {
        return keys.some(k => ['transport', 'protocol', 'command', 'url', 'status', 'health', 'enabled'].includes(k));
    }
    return keys.some(k => ['path', 'skillpath', 'directory', 'source', 'scope', 'enabled', 'disabled'].includes(k));
}
