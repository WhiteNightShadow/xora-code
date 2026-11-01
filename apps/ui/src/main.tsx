import '@xora/ui-kit/tokens.css';
import './app.css';
import './controls.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startApp } from './store.ts';

// The window has no title bar: the top bar leaves room for the platform's window buttons (app.css).
document.documentElement.dataset.platform = /Mac/i.test(navigator.platform)
    ? 'mac'
    : /Win/i.test(navigator.platform)
      ? 'windows'
      : 'linux';

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <App />
        </StrictMode>,
    );
}

// The bootstrap counts the bundle as healthy only after the UI has talked to the host (12 §4).
startApp()
    .then(() => window.xoraShell?.signalReady())
    .catch((error: unknown) => console.error('xora ui failed to start', error));
