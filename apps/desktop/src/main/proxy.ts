import net from 'node:net';
import { session } from 'electron';

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isPortOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: host.replace(/^\[|\]$/g, ''), port });
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function isProxyUsable(rawUrl: string): Promise<boolean> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        // Node's built-in EnvHttpProxyAgent only speaks HTTP/HTTPS proxies (not SOCKS).
        return false;
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
        return true;
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
    return isPortOpen(parsed.hostname, port);
}

async function resolveSystemHttpProxy(): Promise<string | undefined> {
    for (const probeUrl of ['https://api.minimax.io', 'https://api.minimaxi.com']) {
        try {
            const raw = await session.defaultSession.resolveProxy(probeUrl);
            const match = /(?:^|;\s*)(?:(HTTPS?)\s+|PROXY\s+)([^\s;]+)/i.exec(raw);
            if (match?.[2]) {
                const scheme = match[1]?.toLowerCase() === 'https' ? 'https' : 'http';
                const candidate = `${scheme}://${match[2]}`;
                if (await isProxyUsable(candidate)) {
                    return candidate;
                }
            }
        } catch {
            // Ignore proxy resolution errors and try next probe or direct connection.
        }
    }
    return undefined;
}

/**
 * Builds clean proxy environment variables for Host and Engine utility processes:
 * - Strips dead loopback proxies left behind in Windows user environment variables (e.g. closed Clash/v2rayN) or
 *   unsupported `socks5://` URLs that crash Node's `EnvHttpProxyAgent`.
 * - Resolves active Windows/macOS system or PAC proxies via Chromium when no env proxy is set.
 * - Enables `NODE_USE_ENV_PROXY=1` only when a verified HTTP/HTTPS proxy is actually live.
 */
export async function prepareChildProxyEnv(
    baseEnv: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = { ...baseEnv };
    let hasUsableHttpProxy = false;

    for (const key of PROXY_KEYS) {
        const value = out[key]?.trim();
        if (!value) continue;
        if (await isProxyUsable(value)) {
            if (!key.toLowerCase().startsWith('all_')) {
                hasUsableHttpProxy = true;
            }
        } else {
            delete out[key];
        }
    }

    if (!hasUsableHttpProxy) {
        const systemProxy = await resolveSystemHttpProxy();
        if (systemProxy) {
            out.HTTP_PROXY = systemProxy;
            out.HTTPS_PROXY = systemProxy;
            hasUsableHttpProxy = true;
        }
    }

    if (hasUsableHttpProxy) {
        out.NODE_USE_ENV_PROXY = '1';
        if (!out.NO_PROXY && !out.no_proxy) {
            out.NO_PROXY = '127.0.0.1,localhost,::1';
        }
    } else {
        delete out.NODE_USE_ENV_PROXY;
    }

    return out;
}
