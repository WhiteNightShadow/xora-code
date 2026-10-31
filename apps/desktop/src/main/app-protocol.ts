import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSafeRelativePath } from '@xora/updater';
import { net, protocol } from 'electron';

export const APP_SCHEME = 'xora';
export const APP_ORIGIN = 'xora://app';
export const SAFE_MODE_URL = 'xora://safe-mode/index.html';

const SAFE_MODE_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
};

const UI_CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

let bundleRoot: string | undefined;

/** Must run before the app is ready. */
export function registerAppScheme(): void {
    protocol.registerSchemesAsPrivileged([
        { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    ]);
}

/** The verified bundle directory that `xora://app/` currently serves. */
export function setBundleRoot(root: string | undefined): void {
    bundleRoot = root;
}

/**
 * Serves `xora://app/` from the verified bundle and `xora://safe-mode/` from `safeModeDir`, the repair page in
 * app.asar.
 */
export function handleAppScheme(safeModeDir: string): void {
    protocol.handle(APP_SCHEME, async (request) => {
        const url = new URL(request.url);
        let relative: string;
        try {
            relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        } catch {
            return new Response('bad request', { status: 400 });
        }
        if (!isSafeRelativePath(relative)) {
            return new Response('forbidden', { status: 403 });
        }
        if (url.host === 'safe-mode') {
            return serveSafeMode(safeModeDir, relative);
        }
        const root = bundleRoot;
        if (url.host !== 'app' || !root) {
            return new Response('not found', { status: 404 });
        }
        let response: Response;
        try {
            response = await net.fetch(pathToFileURL(path.join(root, ...relative.split('/'))).toString());
        } catch {
            return new Response('not found', { status: 404 });
        }
        const headers = new Headers(response.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        if (relative.endsWith('.html')) {
            headers.set('Content-Security-Policy', UI_CSP);
        }
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
}

/**
 * Reads through Electron's asar-aware `fs`: Chromium's file loader cannot look inside app.asar once the
 * GrantFileProtocolExtraPrivileges fuse is off. The page brings its own Content-Security-Policy.
 */
async function serveSafeMode(dir: string, relative: string): Promise<Response> {
    const type = SAFE_MODE_TYPES[path.extname(relative)];
    if (!type) {
        return new Response('not found', { status: 404 });
    }
    try {
        const body = await readFile(path.join(dir, ...relative.split('/')));
        return new Response(body, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' } });
    } catch {
        return new Response('not found', { status: 404 });
    }
}
