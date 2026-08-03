import { AgentHostEvent, AgentThoughtEvent, SessionRecord, ToolCallEvent } from '../common/agent-protocol';

interface ThoughtExportGroup {
    firstIndex: number;
    text: string;
    elapsedMs?: number;
}

/** Builds a portable, renderer-independent and already-redacted Markdown snapshot. */
export function buildSessionExportMarkdown(
    session: SessionRecord,
    events: AgentHostEvent[],
    exportedAt = new Date()
): string {
    const thoughts = collectThoughts(events);
    const latestTools = latestEventIndexes(events, event => event.kind === 'tool-call'
        ? `${event.turnId ?? 'legacy'}:${event.toolCallId}` : undefined);
    const latestDiffs = latestEventIndexes(events, event => event.kind === 'diff' ? event.diffId : undefined);
    const lines: string[] = [
        `# ${escapeInline(session.title || '未命名会话')}`,
        '',
        `- 导出时间：${exportedAt.toISOString()}`,
        `- 会话更新时间：${session.updatedAt}`,
        `- 模型：${escapeInline(session.model ?? '默认模型')}`,
        `- 状态：${session.status}`,
        '',
        '---',
        ''
    ];

    events.forEach((event, index) => {
        if (event.kind === 'snapshot' || event.kind === 'session' || event.kind === 'supervision-shadow') return;
        if (event.kind === 'thought-delta') {
            const thought = thoughts.get(event.thoughtId);
            if (!thought || thought.firstIndex !== index || !thought.text.trim()) return;
            lines.push(
                '<details>',
                `<summary>思考过程${thought.elapsedMs === undefined ? '' : ` · ${formatDuration(thought.elapsedMs)}`}</summary>`,
                '',
                thought.text.trim(),
                '',
                '</details>',
                ''
            );
            return;
        }
        if (event.kind === 'text-delta') {
            const role = event.role === 'user' ? '用户' : event.role === 'assistant' ? 'Agent' : '系统';
            lines.push(`## ${role}${event.guidance ? ' · 引导当前任务' : ''}`, '', event.text || '');
            if (event.attachments?.length) {
                lines.push('', ...event.attachments.map(attachment =>
                    `- 图片：${escapeInline(attachment.name ?? attachment.mimeType)}（${attachment.byteSize} bytes）`
                ));
            }
            lines.push('');
            return;
        }
        if (event.kind === 'plan') {
            lines.push('### 执行计划', '');
            for (const entry of event.entries) {
                const mark = entry.status === 'completed' ? 'x' : ' ';
                lines.push(`- [${mark}] ${entry.text}（${entry.status}）`);
            }
            lines.push('');
            return;
        }
        if (event.kind === 'tool-call') {
            const key = `${event.turnId ?? 'legacy'}:${event.toolCallId}`;
            if (latestTools.get(key) !== index) return;
            appendTool(lines, event);
            return;
        }
        if (event.kind === 'diff') {
            if (latestDiffs.get(event.diffId) !== index) return;
            lines.push(`### 文件变更 · ${escapeInline(event.path)}`, '', fenced(event.diff, 'diff'), '');
            return;
        }
        if (event.kind === 'permission-request') {
            lines.push(`> 权限请求：${event.title}`, event.detail ? `> ${event.detail}` : '', '');
            return;
        }
        if (event.kind === 'plan-approval-request') {
            lines.push('> 执行计划等待确认', event.planContent ? `> ${event.planContent.replace(/\n/g, '\n> ')}` : '', '');
            return;
        }
        if (event.kind === 'task-contract') {
            lines.push('### 目标与验收条件', '', `目标：${event.objective}`, '');
            lines.push(...event.acceptanceCriteria.map(item => `- [ ] ${item}`), '');
            return;
        }
        if (event.kind === 'goal-state') {
            lines.push(`> 持续完成：${event.status} · 验收 ${event.verificationStatus}`, '');
            return;
        }
        if (event.kind === 'context-usage') {
            const usage = event.context.totalTokens === undefined ? '未知' : event.context.totalTokens.toLocaleString('en-US');
            lines.push(`> 上下文：${usage} tokens · 已整理 ${event.context.compactionCount} 次`, '');
            return;
        }
        if (event.kind === 'turn-completed') {
            lines.push(`> 本轮结束${event.elapsedMs === undefined ? '' : ` · ${formatDuration(event.elapsedMs)}`}${event.stopReason ? ` · ${event.stopReason}` : ''}`, '');
            return;
        }
        if (event.kind === 'error') {
            lines.push(`> 错误：${event.message}`, '');
        }
    });

    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function collectThoughts(events: AgentHostEvent[]): Map<string, ThoughtExportGroup> {
    const result = new Map<string, ThoughtExportGroup>();
    events.forEach((event, index) => {
        if (event.kind !== 'thought-delta') return;
        const existing = result.get(event.thoughtId);
        if (existing) {
            existing.text += event.text;
            if (event.elapsedMs !== undefined) existing.elapsedMs = event.elapsedMs;
        } else {
            result.set(event.thoughtId, {
                firstIndex: index,
                text: event.text,
                ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {})
            });
        }
    });
    return result;
}

function latestEventIndexes(
    events: AgentHostEvent[],
    keyFor: (event: AgentHostEvent) => string | undefined
): Map<string, number> {
    const result = new Map<string, number>();
    events.forEach((event, index) => {
        const key = keyFor(event);
        if (key) result.set(key, index);
    });
    return result;
}

function appendTool(lines: string[], event: ToolCallEvent): void {
    lines.push(`### Agent 活动 · ${escapeInline(event.title)}`, '', `状态：${event.status}${event.elapsedMs === undefined ? '' : ` · ${formatDuration(event.elapsedMs)}`}`);
    if (event.input !== undefined) lines.push('', '参数：', fenced(JSON.stringify(event.input, undefined, 2) ?? String(event.input), 'json'));
    if (event.output) lines.push('', '结果：', fenced(event.output));
    lines.push('');
}

function fenced(value: string, language = ''): string {
    const fence = value.includes('```') ? '````' : '```';
    return `${fence}${language}\n${value}\n${fence}`;
}

function escapeInline(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]<>])/g, '\\$1').trim();
}

function formatDuration(elapsedMs: number): string {
    if (elapsedMs < 1_000) return `${Math.max(0.1, elapsedMs / 1_000).toFixed(1)} 秒`;
    if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(elapsedMs < 10_000 ? 1 : 0)} 秒`;
    const minutes = Math.floor(elapsedMs / 60_000);
    return `${minutes} 分 ${Math.round((elapsedMs % 60_000) / 1_000)} 秒`;
}

/** Type guard retained as a named helper for focused exporter tests. */
export function isThoughtEvent(event: AgentHostEvent): event is AgentThoughtEvent {
    return event.kind === 'thought-delta';
}
