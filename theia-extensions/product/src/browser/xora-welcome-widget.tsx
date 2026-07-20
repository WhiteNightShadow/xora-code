// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, MessageService } from '@theia/core/lib/common';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { AgentHostService, ManagementResult, ProviderProfile } from '@xora-code/agent/lib/common/agent-protocol';
import {
    BuiltInProviderIds,
    WelcomeAction,
    WelcomeCommandIds,
    WELCOME_WORKSPACE_ACTIONS,
    xaiCredentialStatus
} from './xora-welcome-actions';

@injectable()
export class XoraWelcomeWidget extends ReactWidget {
    static readonly ID = 'xora-code-welcome';
    static readonly LABEL = '开始';

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(AgentHostService)
    protected readonly agentHostService!: AgentHostService;

    protected providers: ProviderProfile[] = [];
    protected providerBusy = false;
    protected providerError: string | undefined;

    @postConstruct()
    protected init(): void {
        this.id = XoraWelcomeWidget.ID;
        this.title.label = XoraWelcomeWidget.LABEL;
        this.title.caption = '开始使用 Xora Code';
        this.title.closable = true;
        this.addClass('xora-code-welcome');
        this.node.tabIndex = 0;
        this.update();
        void this.refreshProviders();
    }

    protected override onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        this.node.focus();
    }

    protected render(): React.ReactNode {
        return (
            <main className='xora-code-welcome__content'>
                <div className='xora-code-welcome__mark' aria-hidden='true' />
                <p className='xora-code-welcome__eyebrow'>AI 编程工作台</p>
                <h1>开始使用 Xora Code</h1>
                <p className='xora-code-welcome__lead'>
                    连接你的 Agent，然后打开项目。登录、模型和扩展能力始终可以在 Agent 设置中修改。
                </p>

                <section className='xora-code-welcome__section' aria-labelledby='xora-connect-agent'>
                    <div className='xora-code-welcome__section-heading'>
                        <span>1</span>
                        <div>
                            <h2 id='xora-connect-agent'>连接 Agent</h2>
                            <p>可以现在完成登录或填写密钥，之后也能随时在 Agent 设置中修改。</p>
                        </div>
                    </div>
                    {this.providerError ? <div className='xora-code-welcome__error' role='alert'>{this.providerError}</div> : undefined}
                    <div className='xora-code-welcome__provider-grid'>
                        {this.renderGrokLogin()}
                        {this.renderXaiApiKey()}
                        <article className='xora-code-welcome__provider-card'>
                            <div>
                                <span className='xora-code-welcome__provider-kicker'>兼容接口</span>
                                <h3>自定义 API 与模型</h3>
                                <p>配置 Base URL、模型 ID，以及 OpenAI 或 Anthropic 兼容协议。</p>
                            </div>
                            <button
                                type='button'
                                className='theia-button secondary'
                                onClick={() => this.executeCommand(WelcomeCommandIds.openAgentManagement, '打开 Agent 设置')}
                            >
                                打开 Agent 设置
                            </button>
                        </article>
                    </div>
                </section>

                <section className='xora-code-welcome__section' aria-labelledby='xora-open-workspace'>
                    <div className='xora-code-welcome__section-heading'>
                        <span>2</span>
                        <div>
                            <h2 id='xora-open-workspace'>进入工作台</h2>
                            <p>打开项目后，本页会自动关闭并显示项目文件。</p>
                        </div>
                    </div>
                    <div className='xora-code-welcome__actions'>
                        {WELCOME_WORKSPACE_ACTIONS.map(action => this.renderAction(action))}
                    </div>
                </section>

                <p className='xora-code-welcome__disclaimer'>
                    通过 ACP 集成 Grok Build。Xora Code 是独立社区项目，与 xAI 无隶属、赞助或背书关系。
                </p>
            </main>
        );
    }

    protected renderAction(action: WelcomeAction): React.ReactNode {
        return (
            <button
                key={action.id}
                type='button'
                className={`xora-code-welcome__action xora-code-welcome__action--${action.emphasis ?? 'secondary'}`}
                onClick={() => this.executeCommand(action.commandId, action.title)}
            >
                <span className='xora-code-welcome__action-copy'>
                    <strong>{action.title}</strong>
                    <small>{action.description}</small>
                </span>
                <span className='xora-code-welcome__action-arrow' aria-hidden='true'>→</span>
            </button>
        );
    }

    protected renderGrokLogin(): React.ReactNode {
        return (
            <article className='xora-code-welcome__provider-card xora-code-welcome__provider-card--featured'>
                <div>
                    <span className='xora-code-welcome__provider-kicker'>Grok 订阅</span>
                    <h3>使用 Grok 账号</h3>
                    <p>登录由 Grok Build 完成，并与本机 Grok CLI 共用账号状态。</p>
                </div>
                <div className='xora-code-welcome__provider-actions'>
                    <button
                        type='button'
                        className='theia-button main'
                        disabled={this.providerBusy}
                        onClick={() => this.loginGrok()}
                    >
                        登录或切换账号
                    </button>
                    <button
                        type='button'
                        className='theia-button secondary'
                        disabled={this.providerBusy}
                        onClick={() => this.logoutGrok()}
                    >
                        退出登录
                    </button>
                </div>
            </article>
        );
    }

    protected renderXaiApiKey(): React.ReactNode {
        const provider = this.providers.find(candidate => candidate.id === BuiltInProviderIds.xaiApiKey);
        return (
            <article className='xora-code-welcome__provider-card'>
                <div>
                    <span className='xora-code-welcome__provider-kicker'>xAI API</span>
                    <h3>输入 API Key</h3>
                    <p>{xaiCredentialStatus(provider?.credentialConfigured)}</p>
                </div>
                <form className='xora-code-welcome__key-form' onSubmit={event => this.saveXaiApiKey(event)}>
                    <label htmlFor='xora-xai-api-key'>API Key</label>
                    <input
                        id='xora-xai-api-key'
                        name='apiKey'
                        type='password'
                        required
                        disabled={this.providerBusy || !provider}
                        autoComplete='off'
                        spellCheck={false}
                        placeholder='xai-…'
                    />
                    <div className='xora-code-welcome__provider-actions'>
                        <button className='theia-button main' type='submit' disabled={this.providerBusy || !provider}>保存密钥</button>
                        {provider?.credentialConfigured ? <button
                            className='theia-button secondary'
                            type='button'
                            disabled={this.providerBusy}
                            onClick={() => this.clearXaiApiKey()}
                        >
                            清除密钥
                        </button> : undefined}
                    </div>
                </form>
            </article>
        );
    }

    protected executeCommand(commandId: string, title: string): void {
        void this.commandService.executeCommand(commandId).catch(error => {
            const detail = error instanceof Error ? error.message : String(error);
            this.messageService.error(`无法执行“${title}”：${detail}`);
        });
    }

    protected async refreshProviders(): Promise<void> {
        try {
            this.providers = await this.agentHostService.listProviders();
            this.providerError = undefined;
        } catch (error) {
            this.providerError = `无法读取 Agent 配置：${this.errorMessage(error)}`;
        } finally {
            this.update();
        }
    }

    protected async loginGrok(): Promise<void> {
        await this.runProviderAction(
            () => this.agentHostService.loginGrokSubscription(),
            'Grok 订阅登录已完成。',
            '无法登录 Grok'
        );
    }

    protected async logoutGrok(): Promise<void> {
        await this.runProviderAction(
            () => this.agentHostService.logoutGrokSubscription(),
            '已退出 Grok 登录。',
            '无法退出 Grok 登录'
        );
    }

    protected async saveXaiApiKey(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const form = event.currentTarget;
        const provider = this.providers.find(candidate => candidate.id === BuiltInProviderIds.xaiApiKey);
        const apiKey = String(new FormData(form).get('apiKey') ?? '').trim();
        if (!provider || !apiKey) {
            this.providerError = provider ? '请输入有效的 xAI API Key。' : 'xAI Provider 尚未就绪，请稍后重试。';
            this.update();
            return;
        }
        await this.runProviderAction(
            async () => {
                await this.agentHostService.saveProvider(provider, apiKey);
                await this.agentHostService.selectProvider(provider.id);
                form.reset();
            },
            'xAI API Key 已安全保存，并已设为当前模型服务。',
            '无法保存 xAI API Key'
        );
    }

    protected async clearXaiApiKey(): Promise<void> {
        await this.runProviderAction(
            () => this.agentHostService.clearProviderCredential(BuiltInProviderIds.xaiApiKey),
            '已清除 xAI API Key。',
            '无法清除 xAI API Key'
        );
    }

    protected async runProviderAction(action: () => Promise<void | ManagementResult>, success: string, failure: string): Promise<void> {
        this.providerBusy = true;
        this.providerError = undefined;
        this.update();
        try {
            const result = await action();
            if (result && !result.ok) {
                throw new Error(result.error ?? '操作未完成。');
            }
            this.messageService.info(success);
            await this.refreshProviders();
        } catch (error) {
            this.providerError = `${failure}：${this.errorMessage(error)}`;
        } finally {
            this.providerBusy = false;
            this.update();
        }
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
