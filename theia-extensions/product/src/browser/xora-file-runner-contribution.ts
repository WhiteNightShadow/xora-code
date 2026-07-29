// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { codicon, Saveable } from '@theia/core/lib/browser';
import { Command, CommandContribution, CommandRegistry, MessageService } from '@theia/core/lib/common';
import { isWindows } from '@theia/core/lib/common/os';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { TerminalCommands } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { inject, injectable } from '@theia/core/shared/inversify';
import { createCurrentFileRunnerPlan, RunnerMode, toTerminalCommandArgs } from './current-file-runner';

export const RUN_CURRENT_FILE: Command = {
    id: 'xora-code.run-current-file',
    label: '运行当前文件',
    category: 'Xora Code'
};

export const TEST_CURRENT_FILE: Command = {
    id: 'xora-code.test-current-file',
    label: '测试当前文件',
    category: 'Xora Code'
};

export const CLOSE_CURRENT_TERMINAL_TOOLBAR = 'xora-code.close-current-terminal';

const RUNNER_TERMINAL_KIND = 'xora-code-runner';

@injectable()
export class XoraFileRunnerContribution implements CommandContribution, TabBarToolbarContribution {
    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    @inject(TerminalService)
    protected readonly terminalService!: TerminalService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(RUN_CURRENT_FILE, {
            isEnabled: widget => this.canExecute('run', widget),
            isVisible: widget => this.canExecute('run', widget),
            execute: widget => this.execute('run', widget)
        });
        commands.registerCommand(TEST_CURRENT_FILE, {
            isEnabled: widget => this.canExecute('test', widget),
            isVisible: widget => this.canExecute('test', widget),
            execute: widget => this.execute('test', widget)
        });
    }

    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        toolbar.registerItem({
            id: RUN_CURRENT_FILE.id,
            command: RUN_CURRENT_FILE.id,
            icon: codicon('play'),
            text: '运行',
            tooltip: '运行当前文件 · 输出显示在下方终端',
            priority: 10,
            isVisible: widget => this.canExecute('run', widget)
        });
        toolbar.registerItem({
            id: TEST_CURRENT_FILE.id,
            command: TEST_CURRENT_FILE.id,
            icon: codicon('beaker'),
            text: '测试',
            tooltip: '测试当前文件 · 输出显示在下方终端',
            priority: 11,
            isVisible: widget => this.canExecute('test', widget)
        });
        toolbar.registerItem({
            id: CLOSE_CURRENT_TERMINAL_TOOLBAR,
            command: TerminalCommands.KILL_TERMINAL.id,
            icon: codicon('trash'),
            tooltip: '关闭终端',
            priority: 20,
            isVisible: widget => widget instanceof TerminalWidget
        });
    }

    protected canExecute(mode: RunnerMode, candidate?: unknown): boolean {
        const widget = this.editorWidget(candidate);
        const uri = widget?.getResourceUri();
        if (!uri || uri.scheme !== 'file') {
            return false;
        }
        const plan = createCurrentFileRunnerPlan(uri.path.fsPath(), isWindows ? 'windows' : 'posix');
        return mode === 'run' ? !!plan?.run : !!plan?.test;
    }

    protected async execute(mode: RunnerMode, candidate?: unknown): Promise<void> {
        const widget = this.editorWidget(candidate);
        const uri = widget?.getResourceUri();
        if (!widget || !uri || uri.scheme !== 'file') {
            return;
        }
        const plan = createCurrentFileRunnerPlan(uri.path.fsPath(), isWindows ? 'windows' : 'posix');
        const action = mode === 'run' ? plan?.run : plan?.test;
        if (!plan || !action) {
            return;
        }

        try {
            await Saveable.save(widget);
            if (Saveable.isDirty(widget)) {
                throw new Error('文件仍有未保存的修改');
            }

            const terminal = await this.acquireTerminal();
            await this.terminalService.open(terminal);
            await terminal.executeCommand({
                cwd: uri.parent.path.fsPath(),
                args: toTerminalCommandArgs(action)
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.messageService.error(`无法${mode === 'run' ? '运行' : '测试'} ${uri.path.base}：${detail}`);
        }
    }

    protected editorWidget(candidate?: unknown): EditorWidget | undefined {
        if (candidate instanceof EditorWidget) {
            return candidate;
        }
        // Command Palette calls do not provide a widget. A concrete non-editor
        // candidate comes from another tab-bar toolbar and must stay hidden.
        return candidate === undefined ? this.editorManager.currentEditor : undefined;
    }

    protected async acquireTerminal(): Promise<TerminalWidget> {
        for (const terminal of this.terminalService.all) {
            if (terminal.kind !== RUNNER_TERMINAL_KIND || terminal.isDisposed) {
                continue;
            }
            try {
                if (!await terminal.hasChildProcesses()) {
                    return terminal;
                }
            } catch {
                // A disconnected terminal is replaced below.
            }
        }

        const terminal = await this.terminalService.newTerminal({
            title: 'Xora 运行',
            iconClass: codicon('terminal-cmd'),
            kind: RUNNER_TERMINAL_KIND,
            destroyTermOnClose: true,
            isTransient: true,
            useServerTitle: false
        });
        await terminal.start();
        return terminal;
    }
}
