import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical.ts';

export const MANIFEST_FILE = 'manifest.json';

const SEMVER_LIKE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A POSIX relative path that stays inside the bundle: no absolute paths, `..`, `.`, empty segments or `\`. */
export function isSafeRelativePath(candidate: string): boolean {
    if (candidate.length === 0 || candidate.includes('\\') || candidate.includes('\0')) {
        return false;
    }
    if (candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate)) {
        return false;
    }
    return candidate.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const RelativePathSchema = z.string().max(512).refine(isSafeRelativePath, 'unsafe relative path');

export const ManifestSchema = z.object({
    schemaVersion: z.literal(1),
    version: z.string().regex(SEMVER_LIKE),
    channel: z.enum(['stable', 'beta', 'nightly', 'dev']),
    createdAt: z.string().min(1),
    requires: z.object({
        shell: z.string().min(1),
        schema: z
            .object({
                reads: z.array(z.number().int().nonnegative()).min(1),
                writes: z.number().int().nonnegative(),
            })
            .optional(),
    }),
    entry: z.object({
        host: RelativePathSchema,
        ui: RelativePathSchema,
    }),
    files: z
        .array(
            z.object({
                path: RelativePathSchema,
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
                size: z.number().int().nonnegative(),
            }),
        )
        .min(1),
    signature: z
        .object({
            alg: z.literal('ed25519'),
            keyId: z.string().regex(/^[0-9a-f]{16}$/),
            value: z.string().min(1),
        })
        .optional(),
});

export type BundleManifest = z.infer<typeof ManifestSchema>;
export type UnsignedManifest = Omit<BundleManifest, 'signature'>;

/** keyId → public key in PEM (SPKI) form. */
export type TrustedKeys = Readonly<Record<string, string>>;

export type ManifestCheck =
    | { readonly ok: true; readonly manifest: BundleManifest }
    | { readonly ok: false; readonly reason: string };

export function parseManifest(raw: unknown): ManifestCheck {
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            reason: `invalid-manifest: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        };
    }
    const paths = new Set<string>();
    for (const file of parsed.data.files) {
        if (paths.has(file.path)) {
            return { ok: false, reason: `invalid-manifest: duplicate path ${file.path}` };
        }
        paths.add(file.path);
    }
    return { ok: true, manifest: parsed.data };
}

/** First 16 hex digits of the SHA-256 of the SPKI DER encoding. */
export function keyIdOf(publicKey: KeyObject | string): string {
    const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
    const der = key.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** The exact bytes that are signed: the canonical JSON of the manifest without its signature. */
export function signingPayload(manifest: UnsignedManifest | BundleManifest): Buffer {
    const { signature: _signature, ...unsigned } = manifest as BundleManifest;
    return Buffer.from(canonicalJson(unsigned), 'utf8');
}

export function signManifest(manifest: UnsignedManifest, privateKeyPem: string): BundleManifest {
    const privateKey = createPrivateKey(privateKeyPem);
    const keyId = keyIdOf(createPublicKey(privateKey));
    const value = sign(null, signingPayload(manifest), privateKey).toString('base64');
    return { ...manifest, signature: { alg: 'ed25519', keyId, value } };
}

export function verifyManifestSignature(manifest: BundleManifest, trustedKeys: TrustedKeys): ManifestCheck {
    const signature = manifest.signature;
    if (!signature) {
        return { ok: false, reason: 'unsigned' };
    }
    const publicKeyPem = trustedKeys[signature.keyId];
    if (!publicKeyPem) {
        return { ok: false, reason: `untrusted-key:${signature.keyId}` };
    }
    let valid = false;
    try {
        valid = verify(
            null,
            signingPayload(manifest),
            createPublicKey(publicKeyPem),
            Buffer.from(signature.value, 'base64'),
        );
    } catch {
        valid = false;
    }
    return valid ? { ok: true, manifest } : { ok: false, reason: 'bad-signature' };
}
