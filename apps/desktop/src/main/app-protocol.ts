import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSafeRelativePath } from '@xora/updater';
import { net, protocol } from 'electron';

export const APP_SCHEME = 'xora';
export const APP_ORIGIN = 'xora://app';

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

export function handleAppScheme(): void {
    protocol.handle(APP_SCHEME, async (request) => {
        const root = bundleRoot;
        const url = new URL(request.url);
        if (url.host !== 'app' || !root) {
            return new Response('not found', { status: 404 });
        }
        let relative: string;
        try {
            relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        } catch {
            return new Response('bad request', { status: 400 });
        }
        if (!isSafeRelativePath(relative)) {
            return new Response('forbidden', { status: 403 });
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
