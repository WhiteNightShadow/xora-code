// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const { app, safeStorage } = require('electron');

if (process.env.XORA_CREDENTIAL_SESSION_DATA) {
    app.setPath('sessionData', process.env.XORA_CREDENTIAL_SESSION_DATA);
}

// macOS caches the Keychain encryption key inside this process. Keep that
// native cache for the app session so another Provider/save does not reopen
// Keychain. Other platforms keep the one-request, durable-exit protocol.
const session = process.platform === 'darwin'
    && process.argv.includes('--xora-credential-session');
let lastRequestId = 0;
let processing = false;
let stopping = false;
const parentWatchdog = session
    ? require('./credential-parent-watchdog').startCredentialParentWatchdog(() => { stopping = true; app.quit(); })
    : undefined;
if (parentWatchdog) {
    // A readiness rejection is consumed by each operation below. Register a
    // handler now as the parent may not have sent its first request yet.
    parentWatchdog.ready.catch(() => undefined);
    app.once('will-quit', () => parentWatchdog.stop());
}

// This entry point has only an inherited IPC channel: no renderer, listener
// socket, workspace or credentials in command-line arguments.
app.disableHardwareAcceleration();
if (app.dock) app.dock.hide();
process.once('disconnect', () => { stopping = true; app.quit(); });
async function handleRequest(request) {
    let response;
    let keepAlive = false;
    try {
        if (stopping || (session && (processing || !Number.isSafeInteger(request?.requestId)
            || request.requestId <= lastRequestId))) {
            throw new Error('Invalid session request');
        }
        if (!request || !Array.isArray(request.decrypt) || !Array.isArray(request.encrypt)
            || request.decrypt.length + request.encrypt.length > 256
            || !request.decrypt.every(value => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 64 * 1024)
            || !request.encrypt.every(value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 16 * 1024)) {
            throw new Error('Invalid request');
        }
        processing = true;
        if (session) lastRequestId = request.requestId;
        await parentWatchdog?.ready;
        await app.whenReady();
        if (stopping || !process.connected) return;
        const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
        if (!safeStorage.isEncryptionAvailable() || backend === 'basic_text' || backend === 'unknown') {
            response = { error: 'unavailable' };
        } else {
            response = {
                decrypted: request.decrypt.map(value => safeStorage.decryptString(Buffer.from(value, 'base64'))),
                encrypted: request.encrypt.map(value => safeStorage.encryptString(value).toString('base64'))
            };
            keepAlive = session;
        }
    } catch {
        // Native exception messages can include sensitive payloads. The
        // parent receives only a fixed classification and never logs a key.
        response = { error: 'denied' };
    }
    processing = false;
    if (!keepAlive) stopping = true;
    if (session) response = { ...response, requestId: request?.requestId };
    // Graceful Electron shutdown commits its pending Local State preference
    // writes on Windows/Linux. macOS Keychain writes are synchronous and its
    // parent can accept a reply while the native encryption key remains cached.
    if (process.connected) process.send(response, error => {
        if (error || !keepAlive) app.quit();
    });
    else app.quit();
}

if (session) process.on('message', handleRequest);
else process.once('message', handleRequest);
