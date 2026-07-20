import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandRegistry, ILogger, MAIN_MENU_BAR, MenuModelRegistry } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolbarController } from '@theia/toolbar/lib/browser/toolbar-controller';
import { ToolbarAlignment } from '@theia/toolbar/lib/browser/toolbar-interfaces';
import { missingAgentToolbarCommands, OPEN_AGENT_COMMAND, OPEN_AGENT_SETTINGS_COMMAND } from './agent-entry-commands';
import { XoraAgentWidget } from './agent-widget';

const AGENT_MAIN_MENU = [...MAIN_MENU_BAR, '8_agent'];
const AGENT_MAIN_MENU_ACTIONS = [...AGENT_MAIN_MENU, '1_actions'];

@injectable()
export class AgentViewContribution extends AbstractViewContribution<XoraAgentWidget> implements FrontendApplicationContribution {
    @inject(ToolbarController)
    protected readonly toolbarController!: ToolbarController;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    constructor() {
        super({
            widgetId: XoraAgentWidget.ID,
            widgetName: XoraAgentWidget.LABEL,
            defaultWidgetOptions: { area: 'right', rank: 1000 }
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(OPEN_AGENT_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerSubmenu(AGENT_MAIN_MENU, 'Xora Code');
        menus.registerMenuAction(AGENT_MAIN_MENU_ACTIONS, {
            commandId: OPEN_AGENT_COMMAND.id,
            order: '1'
        });
        menus.registerMenuAction(AGENT_MAIN_MENU_ACTIONS, {
            commandId: OPEN_AGENT_SETTINGS_COMMAND.id,
            order: '2'
        });
    }

    onStart(_app: FrontendApplication): void {
        // ToolbarController becomes ready only after the workbench does.  Do
        // not block startup: keep only the compact settings shortcut. The
        // Xora Code panel itself is already permanently visible.
        void this.installToolbarEntries().catch(error => this.logger.warn('无法安装 Xora Code 设置入口。', error));
    }

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        const widget = await this.widget;
        if (this.shell.getAreaFor(widget) !== 'right') {
            await this.shell.addWidget(widget, this.defaultViewOptions);
        }
        widget.title.closable = false;
        await this.openView({ activate: false, reveal: true });

        const rightPanel = this.shell.rightPanelHandler;
        rightPanel.container.addClass('xora-agent-fixed-panel');
        rightPanel.tabBar.currentChanged.connect(this.ensureAgentPanelVisible, this);
    }

    /**
     * Xora Code is the product's primary surface, not an optional auxiliary
     * view. Generic Theia "collapse right panel" commands and a restored old
     * layout therefore cannot leave it hidden.
     */
    protected ensureAgentPanelVisible(): void {
        const current = this.shell.rightPanelHandler.tabBar.currentTitle?.owner;
        if (current?.id === XoraAgentWidget.ID) return;
        queueMicrotask(() => {
            void this.openView({ activate: false, reveal: true })
                .catch(error => this.logger.warn('无法恢复固定的 Xora Code 面板。', error));
        });
    }

    protected async installToolbarEntries(): Promise<void> {
        await this.toolbarController.ready.promise;
        const existingIds = Object.values(this.toolbarController.toolbarItems.items)
            .flatMap(groups => groups)
            .flatMap(group => group)
            .map(item => item.id);
        for (const command of missingAgentToolbarCommands(existingIds)) {
            await this.toolbarController.addItem(command, ToolbarAlignment.RIGHT);
            existingIds.push(command.id);
        }
    }
}
