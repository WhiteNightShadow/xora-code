// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MAIN_MENU_BAR, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';

/** Main-menu path for Monaco's Selection menu (see MonacoMenus.SELECTION). */
const SELECTION_MENU = [...MAIN_MENU_BAR, '3_selection'] as const;
/** Main-menu path for Debug's Run menu (see DebugMenus.DEBUG). */
const RUN_MENU = [...MAIN_MENU_BAR, '6_debug'] as const;

/**
 * `nls.localizeByDefault('Selection'|'Run')` only applies TextReplacement when
 * a VS Code translation key exists. Those two labels often miss the key map
 * and fall back to English. Re-register the submenus with Chinese labels after
 * all contributions have run so the menu bar stays localized.
 */
@injectable()
export class XoraMenuI18nContribution implements MenuContribution, FrontendApplicationContribution {
    @inject(MenuModelRegistry)
    protected readonly menus!: MenuModelRegistry;

    registerMenus(menus: MenuModelRegistry): void {
        this.applyChineseLabels(menus);
    }

    onStart(): void {
        // Monaco/Debug may register after this contribution depending on load
        // order; force labels again once the workbench is starting.
        this.applyChineseLabels(this.menus);
    }

    protected applyChineseLabels(menus: MenuModelRegistry): void {
        if ((nls.locale ?? '').toLowerCase() !== 'zh-cn') {
            return;
        }
        try {
            menus.registerSubmenu([...SELECTION_MENU], '选择');
        } catch {
            // Submenu may not exist yet in early registerMenus.
        }
        try {
            menus.registerSubmenu([...RUN_MENU], '运行');
        } catch {
            // Same for debug contribution.
        }
    }
}
