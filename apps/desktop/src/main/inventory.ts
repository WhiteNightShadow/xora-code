import path from 'node:path';
import {
    type BundleManifest,
    type Candidate,
    type Inventory,
    isShellCompatible,
    listSlots,
    readManifestFile,
    type TrustedKeys,
    verifyBundleFiles,
    verifyManifestSignature,
} from '@xora/updater';

export type CandidateCheck =
    | { readonly ok: true; readonly manifest: BundleManifest }
    | { readonly ok: false; readonly reason: string };

export interface InventorySources {
    readonly factoryDir: string;
    readonly slotsDir: string;
    readonly trustedKeys: TrustedKeys;
    readonly shellVersion: string;
}

export async function readInventory(sources: InventorySources): Promise<Inventory> {
    const factory = await readManifestFile(sources.factoryDir);
    const slots = await listSlots(sources.slotsDir);
    return factory.ok ? { factory: { version: factory.manifest.version }, slots } : { slots };
}

export function candidateDir(sources: InventorySources, candidate: Candidate): string {
    return candidate.kind === 'factory' ? sources.factoryDir : path.join(sources.slotsDir, candidate.version);
}

/** Full verification before a launch: manifest, version, signature, shell range and every file hash. */
export async function verifyCandidate(sources: InventorySources, candidate: Candidate): Promise<CandidateCheck> {
    const dir = candidateDir(sources, candidate);
    const read = await readManifestFile(dir);
    if (!read.ok) {
        return read;
    }
    if (read.manifest.version !== candidate.version) {
        return { ok: false, reason: `version-mismatch:${read.manifest.version}` };
    }
    const signed = verifyManifestSignature(read.manifest, sources.trustedKeys);
    if (!signed.ok) {
        return signed;
    }
    if (!isShellCompatible(sources.shellVersion, signed.manifest.requires.shell)) {
        return { ok: false, reason: `incompatible-shell:${signed.manifest.requires.shell}` };
    }
    const files = await verifyBundleFiles(dir, signed.manifest);
    return files.ok ? { ok: true, manifest: signed.manifest } : files;
}
