// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { AboutDialog, AboutDialogProps } from '@theia/core/lib/browser/about-dialog';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';

@injectable()
export class XoraAboutDialog extends AboutDialog {
    constructor(@inject(AboutDialogProps) props: AboutDialogProps) {
        super(props);
    }

    protected override renderHeader(): React.ReactNode {
        return <>
            {super.renderHeader()}
            <h3>Agent 运行时</h3>
            <div className='about-details'>
                <p>Xora Code 版本：{this.applicationInfo?.version ?? '0.2.2'}</p>
                <p>Grok Build 基线：0.2.102</p>
                <p>上游公开源码提交：<code>98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce</code></p>
                <p>SOURCE_REV: <code>124d85bc5dc6e7805560215fcc6d5413944920e1</code></p>
                <p>通信方式：基于 stdio 的 ACP · sidecar 自动更新已关闭</p>
                <p>Xora Code 是独立的社区开源项目，与 xAI 不存在隶属、赞助或背书关系。</p>
            </div>
        </>;
    }
}
