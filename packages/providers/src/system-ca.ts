import tls from 'node:tls';

/** A certificate's PEM text without whitespace: Node.js hands out the same certificate wrapped differently. */
export function pemKey(pem: string): string {
    return pem.replace(/\s+/g, '');
}

/**
 * Adds the certificates the operating system trusts, such as the root of a company proxy that inspects TLS, to
 * the roots this process accepts. Node.js otherwise trusts only its bundled roots, and the packaged app ignores
 * `NODE_EXTRA_CA_CERTS` because its nodeOptions fuse is off. Call it once at process start, before any request;
 * returns how many certificates were added.
 */
export function trustSystemCertificates(): number {
    const current = tls.getCACertificates('default');
    const known = new Set(current.map(pemKey));
    const added = tls.getCACertificates('system').filter((certificate) => !known.has(pemKey(certificate)));
    if (added.length > 0) {
        tls.setDefaultCACertificates([...current, ...added]);
    }
    return added.length;
}
