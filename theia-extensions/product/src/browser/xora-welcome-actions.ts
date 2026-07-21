// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

export const WelcomeCommandIds = {
    openFolder: 'workspace:openFolder',
    openAgent: 'xora-code.agent.open',
    openAgentManagement: 'xora-code.agent.management.open',
    focusExplorer: 'workbench.files.action.focusFilesExplorer'
} as const;

export interface WelcomeAction {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly commandId: string;
    readonly emphasis?: 'primary' | 'secondary';
}

export const WELCOME_WORKSPACE_ACTIONS: readonly WelcomeAction[] = [
    {
        id: 'open-project',
        title: '打开项目',
        description: '选择一个文件夹或工作区开始编码',
        commandId: WelcomeCommandIds.openFolder,
        emphasis: 'primary'
    },
    {
        id: 'open-agent',
        title: '打开 Agent',
        description: '显示右侧对话、计划与工具面板',
        commandId: WelcomeCommandIds.openAgent,
        emphasis: 'secondary'
    },
    {
        id: 'agent-settings',
        title: '打开 Agent 设置',
        description: '管理账号、模型、技能、MCP 和插件',
        commandId: WelcomeCommandIds.openAgentManagement,
        emphasis: 'secondary'
    }
] as const;

export function shouldShowWelcome(workspaceRootCount: number): boolean {
    return workspaceRootCount === 0;
}
