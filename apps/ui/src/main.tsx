import '@xora/ui-kit/tokens.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startApp } from './store.ts';

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
