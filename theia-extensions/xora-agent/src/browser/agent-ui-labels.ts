import type { RuntimePhase, ToolCallEvent } from '../common/agent-protocol';
import type { TranscriptEntry } from './agent-view-model';

const RUNTIME_PHASE_LABELS: Record<RuntimePhase, string> = {
    stopped: '未启动',
    starting: '启动中',
    initializing: '初始化中',
    'auth-required': '等待认证确认',
    ready: '就绪',
    draining: '正在结束任务',
    updating: '更新中',
    crashed: '已崩溃'
};

const TOOL_STATUS_LABELS: Record<ToolCallEvent['status'], string> = {
    pending: '等待中',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    rejected: '已拒绝'
};

const TRANSCRIPT_ROLE_LABELS: Record<TranscriptEntry['kind'], string> = {
    user: '你',
    assistant: 'Agent',
    system: '系统',
    plan: '计划',
    tool: '工具',
    permission: '权限请求',
    diff: '文件修改',
    error: '错误'
};

export function runtimePhaseLabel(phase: RuntimePhase): string {
    return RUNTIME_PHASE_LABELS[phase];
}

export function toolStatusLabel(status: ToolCallEvent['status']): string {
    return TOOL_STATUS_LABELS[status];
}

export function transcriptRoleLabel(kind: TranscriptEntry['kind']): string {
    return TRANSCRIPT_ROLE_LABELS[kind];
}
