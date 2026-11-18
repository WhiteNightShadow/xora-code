import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import tls from 'node:tls';

/** A certificate's PEM text without whitespace: Node.js hands out the same certificate wrapped differently. */
export function pemKey(pem: string): string {
    return pem.replace(/\s+/g, '');
}

function isValidPem(pem: string): boolean {
    try {
        new X509Certificate(pem);
        return true;
    } catch {
        return false;
    }
}

/**
 * Adds the certificates the operating system trusts, such as the root of a company proxy that inspects TLS, to
 * the roots this process accepts, and prefers IPv4 so broken Windows IPv6 routes never stall API calls.
 * Malformed entries in the Windows Certificate Store are skipped individually so BoringSSL keeps all valid roots.
 */
export function trustSystemCertificates(): number {
    try {
        dns.setDefaultResultOrder('ipv4first');
    } catch {
        // Ignore if unavailable in restricted runtimes.
    }
    const current = tls.getCACertificates('default');
    const known = new Set(current.map(pemKey));
    // The system list itself can hold a certificate twice (Windows: from several stores; Linux: bundle and folder).
    const added = tls.getCACertificates('system').filter((certificate) => {
        const key = pemKey(certificate);
        if (known.has(key) || !isValidPem(certificate)) return false;
        known.add(key);
        return true;
    });
    if (added.length > 0) {
        tls.setDefaultCACertificates([...current, ...added]);
    }
    return added.length;
}
