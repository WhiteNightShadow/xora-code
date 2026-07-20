import type { Command } from '@theia/core/lib/common';

/**
 * Stable, user-facing entry points.  They deliberately differ from the view
 * toggle commands: a toolbar click must always reveal the requested view,
 * never hide it because the view happens to be active already.
 */
export const OPEN_AGENT_COMMAND: Command = {
    id: 'xora-code.agent.open',
    label: 'Xora Code'
};

export const OPEN_AGENT_SETTINGS_COMMAND: Command = {
    id: 'xora-code.agent.management.open',
    label: 'Agent 设置',
    iconClass: 'codicon codicon-settings-gear'
};

export const AGENT_TOOLBAR_COMMANDS: readonly Command[] = [
    OPEN_AGENT_SETTINGS_COMMAND
];

export function missingAgentToolbarCommands(existingIds: Iterable<string>): Command[] {
    const existing = new Set(existingIds);
    return AGENT_TOOLBAR_COMMANDS.filter(command => !existing.has(command.id));
}
