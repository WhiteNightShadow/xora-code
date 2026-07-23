const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    runtimePhaseLabel,
    toolStatusLabel,
    transcriptRoleLabel
} = require('../lib/browser/agent-ui-labels');
const {
    AGENT_TOOLBAR_COMMANDS,
    missingAgentToolbarCommands
} = require('../lib/browser/agent-entry-commands');

test('Agent runtime, tool and transcript labels are localized for the Chinese UI', () => {
    assert.equal(runtimePhaseLabel('auth-required'), '等待认证确认');
    assert.equal(runtimePhaseLabel('ready'), '就绪');
    assert.equal(runtimePhaseLabel('crashed'), '已崩溃');
    assert.equal(toolStatusLabel('running'), '执行中');
    assert.equal(toolStatusLabel('rejected'), '已拒绝');
    assert.equal(transcriptRoleLabel('user'), '你');
    assert.equal(transcriptRoleLabel('permission'), '权限请求');
});

test('the fixed Xora Code surface keeps only the compact settings toolbar entry', () => {
    assert.deepEqual(
        AGENT_TOOLBAR_COMMANDS.map(command => [command.id, command.label]),
        [
            ['xora-code.agent.management.open', 'Agent 设置']
        ]
    );
    assert.equal(AGENT_TOOLBAR_COMMANDS[0].iconClass, 'codicon codicon-settings-gear');
    assert.deepEqual(
        missingAgentToolbarCommands(['xora-code.agent.open']).map(command => command.id),
        ['xora-code.agent.management.open']
    );
    assert.deepEqual(
        missingAgentToolbarCommands(AGENT_TOOLBAR_COMMANDS.map(command => command.id)),
        []
    );
});

test('Agent view contributions wait for the real toolbar readiness and register view menus', () => {
    const contribution = fs.readFileSync(path.join(__dirname, '../src/browser/agent-view-contribution.ts'), 'utf8');
    const moduleSource = fs.readFileSync(path.join(__dirname, '../src/browser/agent-frontend-module.ts'), 'utf8');
    const widgetSource = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const productStyles = fs.readFileSync(path.join(__dirname, '../../product/src/browser/style/xora-code.css'), 'utf8');
    assert.match(contribution, /await this\.toolbarController\.ready\.promise/);
    assert.doesNotMatch(contribution, /await this\.toolbarController\.ready;/);
    assert.match(moduleSource, /bindViewContribution\(bind, AgentViewContribution\)/);
    assert.match(moduleSource, /bindViewContribution\(bind, AgentManagementContribution\)/);
    assert.match(contribution, /onDidInitializeLayout/);
    assert.match(contribution, /ensureAgentPanelVisible/);
    assert.doesNotMatch(contribution, /toggleCommandId/);
    assert.match(widgetSource, /static readonly LABEL = 'Xora Code'/);
    assert.match(widgetSource, /this\.title\.closable = false/);
    assert.match(productStyles, /#theia-right-content-panel\.xora-agent-fixed-panel/);
    assert.match(productStyles, /text-transform: none/);
});

test('Electron loads the shared Agent frontend before applying its IPC override', () => {
    const manifest = require('../package.json');
    const frontend = manifest.theiaExtensions.find(extension => extension.frontend);
    const electron = manifest.theiaExtensions.find(extension => extension.frontendElectron);
    assert.equal(frontend.frontend, 'lib/browser/agent-frontend-module');
    assert.equal(electron.frontendElectron, 'lib/electron-browser/agent-electron-frontend-module');
    assert.notEqual(frontend, electron);
});

test('Agent composer and transcript include the interaction safeguards used by the desktop UI', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    assert.match(source, /nativeComposing: nativeEvent\.isComposing/);
    assert.match(source, /nativeKeyCode: nativeEvent\.keyCode/);
    assert.match(source, /onCompositionStart=/);
    assert.match(source, /onCompositionEnd=/);
    assert.match(source, /defaultValue=\{this\.prompt\}/);
    assert.doesNotMatch(source, /value=\{this\.prompt\}/);
    assert.doesNotMatch(source, /override update\(\): void/);
    assert.match(source, /role='log'/);
    assert.match(source, /followTranscript\(\)/);
    assert.match(source, /newOutputAvailable/);
    assert.match(source, /scheduleComposerResize\(event\.currentTarget\)/);
    const promptChangeStart = source.indexOf('onChange={event => {', source.indexOf("aria-label='Agent 任务输入框'"));
    const promptChangeEnd = source.indexOf('onCompositionStart=', promptChangeStart);
    assert.ok(promptChangeStart >= 0 && promptChangeEnd > promptChangeStart);
    assert.doesNotMatch(source.slice(promptChangeStart, promptChangeEnd), /this\.update\(\)|requestRuntimePrewarm/);
    assert.match(source, /syncComposerSubmitButton\(\)/);
    assert.match(source, /this\.composerSubmitButton = node;\s*if \(node\) this\.syncComposerSubmitButton\(\);/);
    assert.doesNotMatch(source, /disabled=\{!composerHasContent/,
        'React must not keep a stale disabled prop after native IME input enables the send button');
    assert.match(source, /xora-agent-streaming-text/);
    assert.match(source, /今天想完成什么/);
    assert.match(source, /useSuggestion\(prompt\)/);
    assert.match(source, /protected composerGate\(snapshot: RuntimeSnapshot\)/);
    assert.match(source, /草稿会保留/);
    const gateStart = source.indexOf('protected composerGate(snapshot: RuntimeSnapshot)');
    const gateEnd = source.indexOf('protected requestRuntimePrewarm', gateStart);
    const gate = source.slice(gateStart, gateEnd);
    assert.doesNotMatch(gate, /workspaceTrusted|kind: 'trust'|starting|initializing|draining|updating/,
        'runtime lifecycle states must not reject the first Send');
    assert.match(source, /RUNTIME_PREWARM_DELAY_MS = 0/);
    assert.match(source, /this\.requestRuntimePrewarm\(true\)/);
    assert.match(source, /!root \|\| !snapshot\.workspaceAttached/);
    assert.doesNotMatch(source, /!snapshot\.workspaceTrusted\s*\?\s*this\.renderTrust\(\)/);
    assert.match(source, /const \[saveAll, preparedRuntime\] = await Promise\.all\(\[saveAllPromise, runtimePromise\]\)/);
    assert.match(source, /const runtimeReusable = runtime\.workspaceAttached[\s\S]*?runtime\.phase === 'ready'/);
    assert.match(source, /runtimeReusable[\s\S]*?Promise\.resolve\(runtime\)[\s\S]*?this\.service\.startRuntime\(\{/);
    assert.ok(
        source.indexOf('await this.model.refresh();', source.indexOf('protected async send('))
            < source.indexOf('const runtimeReusable =', source.indexOf('protected async send(')),
        'the renderer may reuse prewarm only after an authoritative Electron snapshot read'
    );
    assert.match(source, /正在连接，随后发送/);
    assert.match(source, /protected renderPendingSubmission\(submission: Pick<PromptSubmission, 'text' \| 'attachments'>\)/);
    assert.match(source, /this\.sendPreparationPreview = \{ text: preparedText, attachments: preparedAttachments \}/,
        'the optimistic user bubble must paint before warm-send preparation finishes');
    assert.match(source, /任务已接收，正在发送/);
    assert.match(source, /submission\.userEventReceived = true/);
    assert.match(source, /event\.kind === 'text-delta' && event\.role === 'user'/);
    assert.match(source, /protected sendPreparationInFlight = false/);
    assert.match(source, /this\.submission \|\| this\.sendPreparationInFlight \|\| this\.sessionLoading/);
    assert.ok(
        source.indexOf('this.sendPreparationInFlight = true;', source.indexOf('protected async send('))
            < source.indexOf('await this.model.refresh();', source.indexOf('protected async send(')),
        'Send must acquire its preparation mutex before refreshing the Provider snapshot'
    );
    assert.ok(
        source.indexOf('const draftTextAtStart = this.prompt;', source.indexOf('protected async send('))
            < source.indexOf('await this.model.refresh();', source.indexOf('protected async send(')),
        'the clicked draft must be frozen before the async Provider refresh'
    );
    assert.match(source, /closePopoverFromScrim\(event/);
    assert.match(source, /requestAnimationFrame\(\(\) => this\.textarea\?\.focus\(\)\)/);
    const textareaStart = source.indexOf("aria-label='Agent 任务输入框'");
    const textareaEnd = source.indexOf('/>', textareaStart);
    assert.ok(textareaStart >= 0 && textareaEnd > textareaStart);
    assert.doesNotMatch(source.slice(textareaStart, textareaEnd), /disabled=/);
});

test('Agent composer accepts pasted images without replacing the native IME textarea', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '../src/browser/style/agent.css'), 'utf8');
    assert.match(source, /onPaste=\{event => \{[\s\S]*?this\.handleImagePaste\(event\);[\s\S]*?\}\}/);
    assert.match(source, /Do not preventDefault/);
    assert.match(source, /aria-label='添加图片'/);
    assert.match(source, /accept='image\/png,image\/jpeg,image\/webp'/);
    assert.match(source, /className='xora-composer-attachments'/);
    assert.match(source, /className='xora-composer-image-error'/);
    assert.match(source, /runtime\.capabilities\?\.prompt\.image !== true/);
    assert.match(source, /attachments: PromptImageAttachment\[\]/);
    assert.match(source, /this\.consumeDraftImages\(submission\.draftAttachmentIds\)/);
    assert.match(source, /generation !== this\.imageReadGeneration/);
    assert.match(source, /contextKey !== this\.imageDraftContextKey\(\)/);
    assert.match(source, /this\.reconcileAgentContext\(\)/);
    assert.match(source, /invalidateAgentContext\('会话已切换，未发送的图片已清除。'\)/);
    assert.doesNotMatch(source, /aria-label='Agent 服务'/);
    assert.match(source, /this\.imagePreviewCloseButton\?\.focus\(\)/);
    assert.match(source, /aria-haspopup='dialog'/);
    assert.doesNotMatch(source, /aria-modal='true'/);
    assert.match(styles, /\.xora-composer-image-preview/);
    assert.match(styles, /\.xora-image-preview-dialog/);
    assert.doesNotMatch(source, /contentEditable/);
});

test('image submissions and session restores stay bound to their original Agent context', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const sendSource = source.slice(source.indexOf('protected async send('), source.indexOf('protected retry('));
    assert.match(source, /readonly contextKey: string/);
    assert.match(source, /readonly generation: number/);
    assert.match(source, /protected agentContextGeneration = 0/);
    assert.match(source, /protected isSubmissionContextCurrent\(submission: PromptSubmission\)/);
    assert.match(source, /if \(retry && !this\.isSubmissionContextCurrent\(retry\)\)/);
    assert.match(source, /if \(!this\.isSubmissionContextCurrent\(submission\)\) return;/);
    assert.match(source, /this\.authenticateRuntime\(runtime, \(\) => this\.isSubmissionContextCurrent\(submission\)\)/);
    assert.match(source, /late failure from an old project\/provider\/session/);
    assert.match(source, /this\.invalidateAgentContext\('项目已变化，未发送的图片已清除。'\)/);
    assert.match(source, /const targetContextKey = this\.agentContextKey\([\s\S]*session\.workspaceRoot,[\s\S]*this\.model\.snapshot\.providerId,[\s\S]*session\.appSessionId/);
    assert.doesNotMatch(source, /此历史仅供查看，请新建会话/);
    assert.match(source, /generation !== this\.sessionLoadGeneration \|\| this\.imageDraftContextKey\(\) !== targetContextKey/);
    assert.match(source, /this\.observedAgentContextKey = targetContextKey;\s*this\.model\.showSessionHistory\(session, cachedHistory \?\? \[\]\)/);
    assert.match(source, /if \(!cachedHistory\) \{[\s\S]*?getSessionHistory\(session\.appSessionId\)[\s\S]*?showSessionHistory\(session, history\)/);
    assert.ok(sendSource.indexOf('this.model.startNewSession()') < sendSource.indexOf('this.service.createSession({'));
    assert.match(source, /if \(previewWasConsumed\) this\.dismissImagePreviewAfterContentRemoval\(\)/);
});

test('Agent activity uses progressive disclosure and keeps permission decisions explicit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    assert.match(source, /className='xora-activity xora-plan-card'/);
    assert.match(source, /className={`xora-activity xora-tool-card/);
    assert.match(source, /className='xora-inline-diff'/);
    assert.match(source, /className='xora-permission-dock'/);
    assert.match(source, /允许一次/);
    assert.match(source, /在此项目允许/);
    assert.match(source, /decidePermission\(permission, 'reject'\)/);
});

test('file changes use compact review cards and reveal the selected file in Explorer', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '../src/browser/style/agent.css'), 'utf8');
    const manifest = require('../package.json');
    assert.equal(manifest.dependencies['@theia/navigator'], '1.73.1');
    assert.match(source, /FileNavigatorCommands\.REVEAL_IN_NAVIGATOR\.id, uri/);
    assert.match(source, /className='xora-diff-file-link'/);
    assert.match(source, /打开并在项目树中定位/);
    assert.match(source, /className='xora-diff-stats'/);
    assert.match(source, /展开补丁/);
    assert.doesNotMatch(source, /在侧栏中展开原始差异/);
    assert.match(styles, /\.xora-diff-file-link:focus-visible/);
    assert.match(styles, /\.xora-diff-stats b/);
    assert.match(styles, /\.xora-diff-actions/);
});

test('Agent asks for shared authentication confirmation only when the backend requires it', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const start = source.indexOf('protected async authenticateRuntime(');
    const end = source.indexOf('protected async workspaceRoot()', start);
    const method = source.slice(start, end);
    const firstAuthentication = method.indexOf('await this.service.authenticate(methodId)');
    const warning = method.indexOf('await this.messages.warn');
    const confirmedAuthentication = method.indexOf('await this.service.authenticate(methodId, true)');

    assert.ok(start >= 0 && end > start);
    assert.ok(firstAuthentication >= 0, 'the backend must be queried before showing a confirmation');
    assert.ok(warning > firstAuthentication, 'the warning must follow the backend confirmation gate');
    assert.ok(confirmedAuthentication > warning, 'the confirmed retry must follow the user choice');
    assert.match(method.slice(firstAuthentication, warning), /status\s*===\s*'authenticated'/);
    assert.match(method, /choice !== '继续'/);
});

test('Agent history, context and model controls keep the sidebar concise and truthful', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '../src/browser/style/agent.css'), 'utf8');
    assert.match(source, /aria-label='打开会话历史'/);
    assert.match(source, /className='xora-agent-popover xora-session-popover'/);
    assert.match(source, /上下文概览/);
    assert.match(source, /className='xora-context-ring'/);
    assert.doesNotMatch(source, />上下文<\/button>/);
    assert.match(source, /正在整理上下文/);
    assert.match(source, /上下文仍由 Grok Build 原生自动管理/);
    assert.match(source, /计费 usage 不参与这里的计算/);
    assert.match(source, /已自动整理 \{summary\.compactionCount\} 次/);
    assert.match(source, /summarizeAgentContext\(snapshot, this\.model\.transcript\)/);
    assert.match(source, /renderModelOptions\(modelChoiceGroups\)/);
    assert.match(source, /agentModelChoiceGroups\(this\.providers, snapshot, active\)/);
    assert.match(source, /decodeAgentModelChoice\(modelId\)/);
    assert.doesNotMatch(source, /await this\.service\.selectProvider\(providerId\)/,
        'the composer must not switch Provider credentials; that belongs to Settings');
    assert.match(source, /选择当前模型服务提供的模型/);
    assert.doesNotMatch(source, /selectDefaultModel\(providerId, catalogModelId\)/);
    assert.doesNotMatch(source, /shouldShowModelSelector\(snapshot, active\)/);
    assert.match(source, /className='xora-model-control'/);
    assert.match(source, /void this\.loadModelOptions\(\)/);
    assert.match(source, /await this\.service\.startRuntime\(\{ workspaceRoot: root, providerId \}\)/);
    assert.match(source, /model: this\.newSessionModel \?\? contextSnapshot\.selectedModel/);
    assert.match(styles, /mask: url\('\.\/agent-mark\.png'\)/);
    assert.doesNotMatch(source, /<option value=''>\{active\?\.model \?\? '默认模型'\}<\/option>/);
});

test('Agent composer shows only model and permission selection on one row', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '../src/browser/style/agent.css'), 'utf8');
    const selectorStart = source.indexOf("<div className='xora-composer-selectors'>");
    const selectorEnd = source.indexOf("<span className='xora-image-live'", selectorStart);
    const selectors = source.slice(selectorStart, selectorEnd);
    assert.ok(selectorStart >= 0 && selectorEnd > selectorStart);
    assert.match(selectors, /aria-label='Agent 模型'/);
    assert.match(selectors, /aria-label='Agent 全局权限'/);
    assert.doesNotMatch(selectors, /aria-label='Agent 服务'/);
    assert.ok(selectors.indexOf("aria-label='Agent 模型'") < selectors.indexOf("aria-label='Agent 全局权限'"));
    assert.match(styles, /\.xora-composer-selectors\s*\{[\s\S]*?flex-wrap: nowrap;/);
    assert.match(styles, /\.xora-composer-selectors label\s*\{[\s\S]*?flex: 1 1 0;/);
});

test('Agent permission mode is explicit, application-wide and confirmed before full access', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    assert.match(source, /aria-label='Agent 全局权限'/);
    assert.match(source, /<option value='request-approval'>请求审批<\/option>/);
    assert.match(source, /<option value='full-access'>完全访问权限<\/option>/);
    assert.match(source, /所有项目、会话和窗口/);
    assert.match(source, /setPermissionMode\(mode\)/);
    assert.doesNotMatch(source, /newSessionPermissionMode/);
    assert.doesNotMatch(source, /permissionMode: this\./);
});

test('Agent output renders safe Markdown and groups categorized tool activity', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '../src/browser/style/agent.css'), 'utf8');
    assert.match(source, /<AgentMarkdown[\s\S]*?text=\{entry\.text\}[\s\S]*?onOpenPath=/);
    assert.match(source, /className='xora-activity xora-tool-group'/);
    assert.match(source, /Agent 活动/);
    assert.match(source, /presentAgentTool\(tool\)/);
    assert.match(source, /对话/);
    assert.match(source, /活动/);
    assert.match(source, /变更/);
    assert.match(source, /summarizeToolCategories\(tools\)/);
    assert.match(source, /expanded \? <div className='xora-activity-body'>/);
    assert.match(source, /this\.agentPaneView === 'conversation' \|\| tools\.length > 1/);
    assert.match(source, /this\.renderToolGroup\(tools, this\.agentPaneView === 'conversation'\)/);
    assert.match(source, /const defaultExpanded = compact \? false : active \|\| failed/);
    assert.match(source, /\{tool\.output \? <pre/);
    assert.match(styles, /--xora-agent-content-font-size: 12\.5px;/);
    assert.match(styles, /\.xora-agent-markdown-code\s*\{[\s\S]*?font-size: 10\.5px;/);
    assert.match(styles, /\.xora-agent-markdown-table-wrap\s*\{[\s\S]*?overflow-x: auto;/);
    assert.match(styles, /\.xora-activity-body pre,[\s\S]*?font-size: 10\.5px;/);
});
