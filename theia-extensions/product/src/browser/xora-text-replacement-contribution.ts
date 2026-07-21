// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { injectable } from '@theia/core/shared/inversify';
import { TextReplacementContribution } from '@theia/core/lib/browser/preload/text-replacement-contribution';

/**
 * Product-owned translations for strings that are missing from Theia's
 * Simplified Chinese bundle or never reach the language-pack path (for example
 * top-level menus keyed via localizeByDefault). Replacements are keyed by the
 * original English defaults expected by TextReplacementContribution.
 */
@injectable()
export class XoraTextReplacementContribution implements TextReplacementContribution {
    getReplacement(locale: string): Record<string, string> {
        if (locale.toLowerCase() !== 'zh-cn') {
            return {};
        }

        return {
            // Workspace trust
            'Do you trust the authors of the files in this folder?': '是否信任此文件夹中的文件作者？',
            "No, I don't trust the authors": '不信任，以受限模式打开',
            'Yes, I trust the authors': '信任并继续',
            'If you trust the authors, code in this folder may be executed, including tasks, debug configurations, extensions, and AI features.':
                '信任后，此文件夹中的代码可能会被执行，包括任务、调试配置、扩展和 Agent 功能。',
            "If you don't trust the authors, the workspace will open in Restricted Mode, which disables these features to protect against potentially harmful code.":
                '如果不信任，项目将以受限模式打开，并禁用这些功能，以防范潜在的恶意代码。',
            "Learn more about Theia's Workspace Trust": '了解项目信任机制',

            // Main menu bar
            'File': '文件',
            'Edit': '编辑',
            'Selection': '选择',
            'View': '查看',
            'Go': '转到',
            'Run': '运行',
            'Terminal': '终端',
            'Help': '帮助',

            // Common File menu
            'New File...': '新建文件...',
            'New Text File': '新建文本文件',
            'Open...': '打开...',
            'Open Folder...': '打开文件夹...',
            'Open Workspace...': '打开工作区...',
            'Open Recent': '打开最近的文件',
            'Save': '保存',
            'Save As...': '另存为...',
            'Save All': '全部保存',
            'Auto Save': '自动保存',
            'Close Editor': '关闭编辑器',
            'Close Folder': '关闭文件夹',
            'Close Workspace': '关闭工作区',
            'Close Window': '关闭窗口',
            'Exit': '退出',
            'Quit': '退出',

            // Edit / clipboard
            'Undo': '撤销',
            'Redo': '重做',
            'Cut': '剪切',
            'Copy': '复制',
            'Paste': '粘贴',
            'Find': '查找',
            'Replace': '替换',
            'Find in Files': '在文件中查找',
            'Replace in Files': '在文件中替换',

            // View
            'Command Palette...': '命令面板...',
            'Explorer': '资源管理器',
            'Search': '搜索',
            'Source Control': '源代码管理',
            'Run and Debug': '运行和调试',
            'Extensions': '扩展',
            'Output': '输出',
            'Problems': '问题',
            'Debug Console': '调试控制台',
            'Appearance': '外观',
            'Editor Layout': '编辑器布局',
            'Toggle Primary Side Bar Visibility': '切换主侧栏可见性',
            'Toggle Panel Visibility': '切换面板可见性',
            'Toggle Status Bar Visibility': '切换状态栏可见性',
            'Toggle Menu Bar': '切换菜单栏',
            'Zoom In': '放大',
            'Zoom Out': '缩小',
            'Reset Zoom': '重置缩放',

            // Terminal
            'New Terminal': '新建终端',
            'Split Terminal': '拆分终端',
            'Kill Terminal': '终止终端',
            'Clear': '清除',

            // Help / About
            'About': '关于',
            'Documentation': '文档',
            'Show All Commands': '显示所有命令',
            'Keyboard Shortcuts Reference': '键盘快捷键参考',

            // Common dialogs / actions
            'Cancel': '取消',
            'OK': '确定',
            'Yes': '是',
            'No': '否',
            'Open': '打开',
            'Close': '关闭',
            'Delete': '删除',
            'Rename': '重命名',
            'Refresh': '刷新',
            'Settings': '设置',
            'Preferences': '首选项',
            'Open Settings': '打开设置',
            'Open Keyboard Shortcuts': '打开键盘快捷方式',
            'Select Color Theme': '选择颜色主题',
            'Select File Icon Theme': '选择文件图标主题',
            'Themes': '主题',
            'Accounts': '账户',
            'Loading...': '正在加载...',
            'Are you sure you want to quit?': '确定要退出吗？',
            'Do you want to terminate the active terminal session?': '是否终止当前活动的终端会话？',
            'Add Folder to Workspace': '将文件夹添加到工作区',
            'Save Workspace As...': '工作区另存为...',
            'Duplicate Workspace': '复制工作区',
            'Pin': '固定',
            'Unpin': '取消固定',
            'Close All': '全部关闭',
            'Close Others': '关闭其他',
            'Close Saved': '关闭已保存',
            'Close to the Right': '关闭右侧',
            'Collapse All': '全部折叠',
            'Expand All': '全部展开',
            'Copy Path': '复制路径',
            'Copy Relative Path': '复制相对路径',
            'Reveal in Finder': '在 Finder 中显示',
            'Reveal in File Explorer': '在文件资源管理器中显示',
            'Open Containing Folder': '打开所在文件夹',
            'New Folder...': '新建文件夹...',
            'Upload Files...': '上传文件...',
            'Download...': '下载...',
            'Compare with Selected': '与所选内容比较',
            'Select for Compare': '选择以进行比较',
            'Open to the Side': '在侧边打开',
            'Open With...': '打开方式...',
            'Go to File...': '转到文件...',
            'Go to Line/Column...': '转到行/列...',
            'Go to Symbol in Editor...': '转到编辑器中的符号...',
            'Go to Symbol in Workspace...': '转到工作区中的符号...',
            'Go to Definition': '转到定义',
            'Go to Declaration': '转到声明',
            'Go to Type Definition': '转到类型定义',
            'Go to Implementations': '转到实现',
            'Go to References': '转到引用',
            'Peek': '速览',
            'References': '引用',
            'Format Document': '格式化文档',
            'Format Selection': '格式化选定内容',
            'Change Language Mode...': '更改语言模式...',
            'Change End of Line Sequence': '更改行尾序列',
            'Change File Encoding': '更改文件编码',
            'Toggle Word Wrap': '切换自动换行',
            'Toggle Line Comment': '切换行注释',
            'Toggle Block Comment': '切换块注释',
            'Indent Using Spaces': '使用空格缩进',
            'Indent Using Tabs': '使用制表符缩进',
            'Convert Indentation to Spaces': '将缩进转换为空格',
            'Convert Indentation to Tabs': '将缩进转换为制表符',
            'Trim Trailing Whitespace': '修剪尾随空格',
            'Workspace': '工作区',
            'Folder': '文件夹',
            'Files': '文件',
            'Open Editors': '打开的编辑器',
            'Outline': '大纲',
            'Timeline': '时间线',
            'No Folder Opened': '未打开文件夹',
            'You have not yet opened a folder.': '你尚未打开文件夹。',
            'Open Folder': '打开文件夹',
            'Clone Git Repository...': '克隆 Git 仓库...',
            'Recent': '最近打开',
            'More...': '更多...',
            'Get Started': '开始使用',
            'Welcome': '欢迎',
            'New Window': '新建窗口',
            'Minimize': '最小化',
            'Zoom': '缩放',
            'Bring All to Front': '全部置于顶层'
        };
    }
}
