// The repair page ships inside the frozen bootstrap: plain DOM code, no build step, no app bundle needed.

const REASONS = {
    requested: '你要求进入修复模式。',
    'all-failed': '所有可用的版本都没能正常启动，已自动进入修复模式。',
    'boot-loop': '启动反复失败，已自动进入修复模式。',
};

const ROLES = {
    current: '当前版本',
    previous: '上一版',
    pending: '待生效更新',
    lastGood: '最近一次正常',
    factory: '内置基线',
};

const api = window.xoraSafe;
const $ = (id) => document.getElementById(id);

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
        const roles = candidate.roles.map((role) => ROLES[role] ?? role).join('、');
        row.append(cell(`${candidate.version}${roles ? `（${roles}）` : ''}`));
        if (!candidate.ok) {
            row.append(cell('校验失败', 'bad'), cell(candidate.problem ?? ''));
        } else if (candidate.bad) {
            row.append(cell('曾启动失败', 'warn'), cell(candidate.bad.reason));
        } else {
            row.append(cell('可用', 'ok'), cell(''));
        }
        const action = document.createElement('td');
        if (candidate.ok) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = '用这个版本启动';
            button.addEventListener('click', async () => {
                button.disabled = true;
                notice(`正在切换到${candidate.version}…`);
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
    $('reason').textContent = REASONS[status.reason] ?? `原因：${status.reason}`;
    renderCandidates(status.candidates);
    if (status.factoryMissing) {
        notice('安装包里的内置基线缺失或损坏，建议重新安装。数据目录不会受影响。');
    }
    $('last-failure').textContent = status.lastFailure
        ? `最近一次失败：${status.lastFailure.id}，${status.lastFailure.reason}（${status.lastFailure.at}）`
        : '';
    $('versions').textContent =
        `shell ${status.shellVersion} · ${status.platform} · electron ${status.versions.electron}`;
    document.body.dataset.state = 'ready';
    document.body.dataset.candidates = String(status.candidates.length);
}

$('export').addEventListener('click', async () => {
    const file = await api.exportDiagnostics();
    notice(file ? `诊断信息已保存到：${file}` : '已取消。');
});
$('logs').addEventListener('click', async () => {
    const result = await api.openLogs();
    notice(result === true ? '' : `无法打开日志目录：${result}`);
});
$('restart').addEventListener('click', () => api.restartNormal());
$('quit').addEventListener('click', () => api.quit());

refresh().catch((error) => {
    document.body.dataset.state = 'error';
    $('reason').textContent = `读取状态失败：${String(error?.message ?? error)}`;
});
