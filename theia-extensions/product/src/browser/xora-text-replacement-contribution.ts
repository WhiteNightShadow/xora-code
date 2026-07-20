// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { injectable } from '@theia/core/shared/inversify';
import { TextReplacementContribution } from '@theia/core/lib/browser/preload/text-replacement-contribution';

/**
 * Product-owned translations for strings that are missing from Theia's
 * Simplified Chinese bundle. This runs during Theia's supported preload phase,
 * before dialogs are created, and deliberately keys replacements by the
 * original English defaults expected by TextReplacementContribution.
 */
@injectable()
export class XoraTextReplacementContribution implements TextReplacementContribution {
    getReplacement(locale: string): Record<string, string> {
        if (locale.toLowerCase() !== 'zh-cn') {
            return {};
        }

        return {
            'Do you trust the authors of the files in this folder?': '是否信任此文件夹中的文件作者？',
            "No, I don't trust the authors": '不信任，以受限模式打开',
            'Yes, I trust the authors': '信任并继续',
            'If you trust the authors, code in this folder may be executed, including tasks, debug configurations, extensions, and AI features.':
                '信任后，此文件夹中的代码可能会被执行，包括任务、调试配置、扩展和 Agent 功能。',
            "If you don't trust the authors, the workspace will open in Restricted Mode, which disables these features to protect against potentially harmful code.":
                '如果不信任，项目将以受限模式打开，并禁用这些功能，以防范潜在的恶意代码。',
            "Learn more about Theia's Workspace Trust": '了解项目信任机制'
        };
    }
}
