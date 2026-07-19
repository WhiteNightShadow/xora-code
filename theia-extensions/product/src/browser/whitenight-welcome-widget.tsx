// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';

@injectable()
export class WhiteNightWelcomeWidget extends ReactWidget {
    static readonly ID = 'whitenight-code-welcome';
    static readonly LABEL = 'Welcome';

    @postConstruct()
    protected init(): void {
        this.id = WhiteNightWelcomeWidget.ID;
        this.title.label = WhiteNightWelcomeWidget.LABEL;
        this.title.caption = 'Welcome to WhiteNight Code';
        this.title.closable = true;
        this.addClass('whitenight-code-welcome');
        this.node.tabIndex = 0;
        this.update();
    }

    protected override onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        this.node.focus();
    }

    protected render(): React.ReactNode {
        return (
            <main className='whitenight-code-welcome__content'>
                <div className='whitenight-code-welcome__mark' aria-hidden='true'>WN</div>
                <p className='whitenight-code-welcome__eyebrow'>OPEN AGENT WORKBENCH</p>
                <h1>WhiteNight Code</h1>
                <p className='whitenight-code-welcome__lead'>
                    A focused desktop workspace for projects, code, and model-neutral coding agents.
                </p>
                <section className='whitenight-code-welcome__steps' aria-label='Getting started'>
                    <article>
                        <span>1</span>
                        <div>
                            <h2>Open a project</h2>
                            <p>Choose a folder or workspace from the File menu.</p>
                        </div>
                    </article>
                    <article>
                        <span>2</span>
                        <div>
                            <h2>Inspect your code</h2>
                            <p>Use the explorer, editor, search, source control, and terminal.</p>
                        </div>
                    </article>
                    <article>
                        <span>3</span>
                        <div>
                            <h2>Work with an agent</h2>
                            <p>The Agent view will connect compatible runtimes through ACP.</p>
                        </div>
                    </article>
                </section>
                <p className='whitenight-code-welcome__lead'>
                    Integrates Grok Build 0.2.102 through ACP. WhiteNight Code is an independent community project and is not affiliated with or endorsed by xAI.
                </p>
            </main>
        );
    }
}
