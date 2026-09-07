// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const { app, safeStorage } = require('electron');

// This entry point runs only in a separate Electron main process with an
// inherited IPC channel. It never loads Theia, a workspace or a browser window.
app.disableHardwareAcceleration();
if (app.dock) app.dock.hide();
process.once('disconnect', () => app.exit());
process.once('message', async request => {
    let response;
    try {
        if (!request || !Array.isArray(request.decrypt) || !Array.isArray(request.encrypt)
            || request.decrypt.length + request.encrypt.length > 256
            || !request.decrypt.every(value => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 64 * 1024)
            || !request.encrypt.every(value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 16 * 1024)) {
            throw new Error('Invalid request');
        }
        await app.whenReady();
        const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
        if (!safeStorage.isEncryptionAvailable() || backend === 'basic_text' || backend === 'unknown') {
            response = { error: 'unavailable' };
        } else {
            response = {
                decrypted: request.decrypt.map(value => safeStorage.decryptString(Buffer.from(value, 'base64'))),
                encrypted: request.encrypt.map(value => safeStorage.encryptString(value).toString('base64'))
            };
        }
    } catch {
        // Native exception messages can include sensitive payloads. The
        // parent receives only a fixed classification and never logs a key.
        response = { error: 'denied' };
    }
    if (process.connected) process.send(response, () => app.exit());
    else app.exit();
});
