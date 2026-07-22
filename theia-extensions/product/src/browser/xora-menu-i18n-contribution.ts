// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MAIN_MENU_BAR, MenuModelRegistry } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';

/** Main-menu path for Monaco's Selection menu (see MonacoMenus.SELECTION). */
const SELECTION_MENU = [...MAIN_MENU_BAR, '3_selection'] as const;
/** Main-menu path for Debug's Run menu (see DebugMenus.DEBUG). */
const RUN_MENU = [...MAIN_MENU_BAR, '6_debug'] as const;

interface LabeledMenuNode {
    id: string;
    label?: string;
}

interface MutableMenuParent {
    children: LabeledMenuNode[];
    removeNode(node: LabeledMenuNode): void;
}

/**
 * Localize top-level Selection / Run menus for zh-cn.
 *
 * IMPORTANT: Do NOT call `MenuModelRegistry.registerSubmenu` for menus that
 * already exist as labeled submenus. Theia's registry only replaces a node when
 * it is a Group (no label); for an existing Submenu it *adds another* node with
 * the same id — that produced duplicate「选择」「运行」entries on the menu bar
 * (especially visible on Windows).
 *
 * Instead we mutate the existing submenu's label and drop any same-id siblings.
 * TextReplacementContribution still handles the nls path for other strings.
 */
@injectable()
export class XoraMenuI18nContribution implements FrontendApplicationContribution {
    @inject(MenuModelRegistry)
    protected readonly menus!: MenuModelRegistry;

    onStart(): void {
        this.applyChineseLabels();
    }

    protected applyChineseLabels(): void {
        if ((nls.locale ?? '').toLowerCase() !== 'zh-cn') {
            return;
        }
        this.relabelExistingSubmenu([...SELECTION_MENU], '选择');
        this.relabelExistingSubmenu([...RUN_MENU], '运行');
        this.dedupeMainMenuBar(['3_selection', '6_debug']);
    }

    protected relabelExistingSubmenu(menuPath: string[], label: string): void {
        const node = this.menus.getMenuNode(menuPath) as LabeledMenuNode | undefined;
        if (!node || typeof node.label !== 'string') {
            return;
        }
        if (node.label !== label) {
            node.label = label;
        }
    }

    /**
     * Remove later siblings that share an id with an earlier top-level menu.
     * Safe when a previous buggy registerSubmenu call already injected clones.
     */
    protected dedupeMainMenuBar(ids: readonly string[]): void {
        const bar = this.menus.getMenu([...MAIN_MENU_BAR]) as unknown as MutableMenuParent | undefined;
        if (!bar || !Array.isArray(bar.children) || typeof bar.removeNode !== 'function') {
            return;
        }
        const target = new Set(ids);
        const seen = new Set<string>();
        const extras: LabeledMenuNode[] = [];
        for (const child of bar.children) {
            if (!target.has(child.id)) {
                continue;
            }
            if (seen.has(child.id)) {
                extras.push(child);
            } else {
                seen.add(child.id);
            }
        }
        for (const extra of extras) {
            bar.removeNode(extra);
        }
    }
}
