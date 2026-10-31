// The repair page ships inside the frozen bootstrap: plain DOM code, no build step, no app bundle needed.

// Safe mode runs without the host, so the page follows the system's languages rather than the setting, by the
// rule of resolveLanguage (@xora/protocol): the first preferred language with text, any Chinese as simplified.
const CHINESE =
    navigator.languages
        .map((tag) => tag.split(/[-_]/)[0].toLowerCase())
        .find((code) => code === 'zh' || code === 'en') === 'zh';

const TEXT = CHINESE
    ? {
          pageTitle: 'Xora Code修复模式',
          title: '修复模式',
          loading: '正在读取状态…',
          versions: '可用版本',
          versionsHint: '选择一个校验通过的版本启动。启动成功后，它会成为当前版本。',
          colVersion: '版本',
          colStatus: '状态',
          colNote: '说明',
          other: '其他操作',
          export: '导出诊断信息',
          logs: '打开日志目录',
          disableExtensions: '禁用全部扩展（尚未提供）',
          resetSettings: '重置设置（尚未提供）',
          restart: '正常重启',
          quit: '退出',
          reasons: {
              requested: '你要求进入修复模式。',
              'all-failed': '所有可用的版本都没能正常启动，已自动进入修复模式。',
              'boot-loop': '启动反复失败，已自动进入修复模式。',
          },
          otherReason: (reason) => `原因：${reason}`,
          roles: {
              current: '当前版本',
              previous: '上一版',
              pending: '待生效更新',
              lastGood: '最近一次正常',
              factory: '内置基线',
          },
          withRoles: (version, roles) => `${version}（${roles.join('、')}）`,
          invalid: '校验失败',
          failedBefore: '曾启动失败',
          usable: '可用',
          startThis: '用这个版本启动',
          switching: (version) => `正在切换到${version}…`,
          factoryMissing: '安装包里的内置基线缺失或损坏，建议重新安装。数据目录不会受影响。',
          lastFailure: (failure) => `最近一次失败：${failure.id}，${failure.reason}（${failure.at}）`,
          exported: (file) => `诊断信息已保存到：${file}`,
          cancelled: '已取消。',
          logsFailed: (error) => `无法打开日志目录：${error}`,
          statusFailed: (error) => `读取状态失败：${error}`,
      }
    : {
          pageTitle: 'Xora Code safe mode',
          title: 'Safe mode',
          loading: 'Reading the status…',
          versions: 'Available versions',
          versionsHint: 'Start a version that passed verification. Once it starts, it becomes the current version.',
          colVersion: 'Version',
          colStatus: 'Status',
          colNote: 'Details',
          other: 'Other actions',
          export: 'Export diagnostics',
          logs: 'Open logs folder',
          disableExtensions: 'Disable all extensions (not available yet)',
          resetSettings: 'Reset settings (not available yet)',
          restart: 'Restart normally',
          quit: 'Quit',
          reasons: {
              requested: 'You asked to start in safe mode.',
              'all-failed': 'None of the available versions started, so the app entered safe mode.',
              'boot-loop': 'Starting failed again and again, so the app entered safe mode.',
          },
          otherReason: (reason) => `Reason: ${reason}`,
          roles: {
              current: 'current',
              previous: 'previous',
              pending: 'pending update',
              lastGood: 'last good',
              factory: 'built-in baseline',
          },
          withRoles: (version, roles) => `${version} (${roles.join(', ')})`,
          invalid: 'Failed verification',
          failedBefore: 'Failed to start before',
          usable: 'Available',
          startThis: 'Start this version',
          switching: (version) => `Switching to ${version}…`,
          factoryMissing:
              'The built-in baseline in the installation is missing or damaged; reinstalling is recommended. Your data folder is not affected.',
          lastFailure: (failure) => `Last failure: ${failure.id}, ${failure.reason} (${failure.at})`,
          exported: (file) => `Diagnostics saved to ${file}`,
          cancelled: 'Cancelled.',
          logsFailed: (error) => `Could not open the logs folder: ${error}`,
          statusFailed: (error) => `Could not read the status: ${error}`,
      };

const api = window.xoraSafe;
const $ = (id) => document.getElementById(id);

document.documentElement.lang = CHINESE ? 'zh-CN' : 'en';
document.title = TEXT.pageTitle;
for (const element of document.querySelectorAll('[data-text]')) {
    element.textContent = TEXT[element.dataset.text];
}

function notice(text) {
    $('notice').textContent = text;
}

function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) {
        td.className = className;
    }
    return td;
}

function renderCandidates(candidates) {
    const body = $('candidates');
    body.replaceChildren();
    for (const candidate of candidates) {
        const row = document.createElement('tr');
        row.dataset.candidate = candidate.id;
        const roles = candidate.roles.map((role) => TEXT.roles[role] ?? role);
        row.append(cell(roles.length > 0 ? TEXT.withRoles(candidate.version, roles) : candidate.version));
        if (!candidate.ok) {
            row.append(cell(TEXT.invalid, 'bad'), cell(candidate.problem ?? ''));
        } else if (candidate.bad) {
            row.append(cell(TEXT.failedBefore, 'warn'), cell(candidate.bad.reason));
        } else {
            row.append(cell(TEXT.usable, 'ok'), cell(''));
        }
        const action = document.createElement('td');
        if (candidate.ok) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = TEXT.startThis;
            button.addEventListener('click', async () => {
                button.disabled = true;
                notice(TEXT.switching(candidate.version));
                try {
                    await api.rollback(candidate.id);
                } catch (error) {
                    button.disabled = false;
                    notice(String(error?.message ?? error));
                }
            });
            action.append(button);
        }
        row.append(action);
        body.append(row);
    }
}

async function refresh() {
    const status = await api.status();
    $('reason').textContent = TEXT.reasons[status.reason] ?? TEXT.otherReason(status.reason);
    renderCandidates(status.candidates);
    if (status.factoryMissing) {
        notice(TEXT.factoryMissing);
    }
    $('last-failure').textContent = status.lastFailure ? TEXT.lastFailure(status.lastFailure) : '';
    $('versions').textContent =
        `shell ${status.shellVersion} · ${status.platform} · electron ${status.versions.electron}`;
    document.body.dataset.state = 'ready';
    document.body.dataset.candidates = String(status.candidates.length);
}

$('export').addEventListener('click', async () => {
    const file = await api.exportDiagnostics();
    notice(file ? TEXT.exported(file) : TEXT.cancelled);
});
$('logs').addEventListener('click', async () => {
    const result = await api.openLogs();
    notice(result === true ? '' : TEXT.logsFailed(result));
});
$('restart').addEventListener('click', () => api.restartNormal());
$('quit').addEventListener('click', () => api.quit());

refresh().catch((error) => {
    document.body.dataset.state = 'error';
    $('reason').textContent = TEXT.statusFailed(String(error?.message ?? error));
});
