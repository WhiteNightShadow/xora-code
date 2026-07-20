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
            <h3>Agent runtime</h3>
            <div className='about-details'>
                <p>Grok Build baseline: 0.2.102</p>
                <p>Public source commit: <code>98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce</code></p>
                <p>SOURCE_REV: <code>124d85bc5dc6e7805560215fcc6d5413944920e1</code></p>
                <p>Transport: ACP over stdio · auto-update disabled in the sidecar</p>
                <p>Xora Code is an independent community project and is not affiliated with or endorsed by xAI.</p>
            </div>
        </>;
    }
}
