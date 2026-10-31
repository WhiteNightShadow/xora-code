import { type LanguageSetting, resolveLanguage, type UiLanguage } from '@xora/protocol/language';
import { app } from 'electron';

/**
 * The shell's own text: menus, the tray and dialogs. It follows the language setting the host reports
 * (`shell.language`); before that, and in safe mode, the system's languages. The repair page has its own copy
 * (static/safe-mode).
 */
const zh = {
    help: '帮助',
    view: '视图',
    restartSafeMode: '重启到修复模式',
    openLogs: '打开日志目录',
    reload: '重新加载界面',
    chooseFolder: '选择文件夹',
    cannotStart: 'Xora Code无法启动',
    showApp: '显示Xora Code',
    quit: '退出',
    trayTooltip: (count: number) => `Xora Code：${count}个任务在运行`,
    trayRunning: (count: number) => `运行中（${count}）`,
    backgroundRunning: (count: number) => `${count}个任务在后台继续运行，点托盘图标可以打开窗口`,
    backgroundTriggers: '有自动运行的工作流，应用留在托盘里，点托盘图标可以打开窗口',
    slowStart: '界面启动时间过长',
    slowStartDetail: (version: string, seconds: number) =>
        `应用包${version}在${seconds}秒内没有完成启动。可以继续等待，也可以回滚到上一个能用的版本，或者进入修复模式。`,
    keepWaiting: '继续等待',
    rollBack: '回滚到上一版',
    enterSafeMode: '进入修复模式',
    safeModeTitle: 'Xora Code修复模式',
    exportDiagnostics: '导出诊断信息',
    cannotLaunch: (reason: string) => `该版本无法启动：${reason}`,
};

export type ShellStrings = typeof zh;

const tasks = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`;

const en: ShellStrings = {
    help: 'Help',
    view: 'View',
    restartSafeMode: 'Restart in safe mode',
    openLogs: 'Open logs folder',
    reload: 'Reload UI',
    chooseFolder: 'Choose a folder',
    cannotStart: 'Xora Code could not start',
    showApp: 'Show Xora Code',
    quit: 'Quit',
    trayTooltip: (count) => `Xora Code: ${tasks(count)} running`,
    trayRunning: (count) => `Running (${count})`,
    backgroundRunning: (count) =>
        `${tasks(count)} still running in the background. Click the tray icon to open the window.`,
    backgroundTriggers:
        'Workflows run automatically, so the app stays in the tray. Click the tray icon to open the window.',
    slowStart: 'The UI is taking too long to start',
    slowStartDetail: (version, seconds) =>
        `App bundle ${version} did not finish starting within ${seconds} seconds. You can keep waiting, roll back to the last version that worked, or enter safe mode.`,
    keepWaiting: 'Keep waiting',
    rollBack: 'Roll back',
    enterSafeMode: 'Enter safe mode',
    safeModeTitle: 'Xora Code safe mode',
    exportDiagnostics: 'Export diagnostics',
    cannotLaunch: (reason) => `This version cannot start: ${reason}`,
};

const STRINGS: Record<UiLanguage, ShellStrings> = { 'zh-CN': zh, en };

let setting: LanguageSetting = 'system';
const listeners = new Set<() => void>();

/** `system` reads the app locale (which `--lang` sets), so only call this once the app is ready. */
function language(): UiLanguage {
    return resolveLanguage(setting, [app.getLocale(), ...app.getPreferredSystemLanguages()]);
}

export function shellStrings(): ShellStrings {
    return STRINGS[language()];
}

export function setLanguageSetting(next: LanguageSetting): void {
    const before = language();
    setting = next;
    if (language() !== before) {
        for (const listener of listeners) {
            listener();
        }
    }
}

/** Calls `listener` whenever the shell's language changes; returns the unsubscribe function. */
export function onLanguageChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
