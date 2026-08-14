import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    AgentAttachmentSummary,
    PromptImageAttachment,
    PromptImageMimeType
} from '../common/agent-protocol';

export const MAX_PROMPT_IMAGE_COUNT = 4;
export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ValidatedPromptImageAttachments {
    /** ACP image content blocks. This is transient and must never be logged. */
    blocks: Array<{ type: 'image'; mimeType: PromptImageMimeType; data: string }>;
    /** Persistable metadata with no base64 payload. */
    summaries: AgentAttachmentSummary[];
    /** Decoded bytes are Electron-main only and must never cross RPC/logs. */
    files: Array<{
        mimeType: PromptImageMimeType;
        data: Buffer;
        summary: AgentAttachmentSummary;
    }>;
}

export interface PersistedPromptImageAttachments {
    summaries: AgentAttachmentSummary[];
    workspacePaths: string[];
}

/**
 * Validates the renderer RPC boundary before any ACP request is created.
 * Standard canonical base64 is required so alternate encodings cannot bypass
 * byte limits or produce ambiguous hashes.
 */
export function validatePromptImageAttachments(value: unknown): ValidatedPromptImageAttachments {
    if (value === undefined) return { blocks: [], summaries: [], files: [] };
    if (!Array.isArray(value)) throw new Error('Image attachments must be an array.');
    if (value.length > MAX_PROMPT_IMAGE_COUNT) {
        throw new Error(`A prompt can contain at most ${MAX_PROMPT_IMAGE_COUNT} images.`);
    }

    const blocks: ValidatedPromptImageAttachments['blocks'] = [];
    const summaries: AgentAttachmentSummary[] = [];
    const files: ValidatedPromptImageAttachments['files'] = [];
    let totalBytes = 0;
    for (const item of value) {
        const attachment = requireAttachmentRecord(item);
        const decoded = decodeCanonicalBase64(attachment.data);
        if (decoded.length === 0) throw new Error('Image attachments cannot be empty.');
        if (decoded.length > MAX_PROMPT_IMAGE_BYTES) {
            throw new Error('Each image attachment must be 5 MiB or smaller.');
        }
        totalBytes += decoded.length;
        if (totalBytes > MAX_PROMPT_IMAGE_BYTES) {
            throw new Error('Image attachments must be 5 MiB or smaller in total.');
        }
        if (!matchesMagicBytes(attachment.mimeType, decoded)) {
            throw new Error('An image attachment does not match its declared MIME type.');
        }
        const name = validateAttachmentName(attachment.name);
        blocks.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data });
        const summary: AgentAttachmentSummary = {
            kind: 'image',
            mimeType: attachment.mimeType,
            byteSize: decoded.length,
            sha256: crypto.createHash('sha256').update(decoded).digest('hex'),
            ...(name ? { name } : {})
        };
        summaries.push(summary);
        files.push({ mimeType: attachment.mimeType, data: decoded, summary });
    }
    return { blocks, summaries, files };
}

/**
 * Saves validated images under the current project without trusting a
 * renderer-provided path. The content-addressed path is stable across Xora
 * restarts, while O_NOFOLLOW and component-by-component checks prevent a
 * workspace symlink from redirecting writes outside the project.
 */
export function persistPromptImagesToWorkspace(
    workspaceRoot: string,
    appSessionId: string,
    images: ValidatedPromptImageAttachments
): PersistedPromptImageAttachments {
    if (!images.files.length) return { summaries: [], workspacePaths: [] };
    if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) throw new Error('Unsafe session identifier.');
    const canonicalRoot = fs.realpathSync.native(workspaceRoot);
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error('Workspace root must be a directory.');

    const directory = ensureSafeDirectoryChain(canonicalRoot, ['.xora', 'attachments', appSessionId]);
    const summaries: AgentAttachmentSummary[] = [];
    const workspacePaths: string[] = [];
    for (const file of images.files) {
        const extension = imageExtension(file.mimeType);
        const filename = `${file.summary.sha256}${extension}`;
        const target = path.join(directory, filename);
        writeContentAddressedImage(target, file.data, file.summary.sha256);
        const workspacePath = ['.xora', 'attachments', appSessionId, filename].join('/');
        workspacePaths.push(workspacePath);
        summaries.push({ ...file.summary, workspacePath });
    }
    return { summaries, workspacePaths };
}

function ensureSafeDirectoryChain(root: string, components: string[]): string {
    let current = root;
    for (const component of components) {
        if (!/^[A-Za-z0-9._-]+$/.test(component)) throw new Error('Unsafe attachment directory.');
        current = path.join(current, component);
        let created = false;
        try {
            fs.mkdirSync(current, { mode: 0o700 });
            created = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('Refusing an unsafe workspace attachment directory.');
        }
        // Never rewrite permissions on a user-owned pre-existing `.xora`
        // directory. Newly created attachment directories remain private.
        if (created) fs.chmodSync(current, 0o700);
    }
    return current;
}

function writeContentAddressedImage(target: string, data: Buffer, expectedHash: string): void {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    try {
        const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
        try {
            fs.writeFileSync(descriptor, data);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing an unsafe workspace attachment path.');
        const existingHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        if (existingHash !== expectedHash) throw new Error('Refusing a corrupted workspace image attachment.');
    }
    fs.chmodSync(target, 0o600);
}

function imageExtension(mimeType: PromptImageMimeType): string {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/jpeg') return '.jpg';
    return '.webp';
}

function requireAttachmentRecord(value: unknown): PromptImageAttachment {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid image attachment.');
    }
    const record = value as Record<string, unknown>;
    if (!isPromptImageMimeType(record.mimeType)) {
        throw new Error('Only PNG, JPEG and WebP image attachments are supported.');
    }
    if (typeof record.data !== 'string') throw new Error('Image attachment data must be base64.');
    if (record.name !== undefined && typeof record.name !== 'string') {
        throw new Error('Image attachment names must be strings.');
    }
    return {
        mimeType: record.mimeType,
        data: record.data,
        ...(record.name === undefined ? {} : { name: record.name as string })
    };
}

function decodeCanonicalBase64(data: string): Buffer {
    // The decoded size limit has a small fixed encoded upper bound. Rejecting
    // before Buffer allocation also protects main from oversized renderer RPC.
    const maximumEncodedLength = Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4;
    if (data.length > maximumEncodedLength) {
        throw new Error('Each image attachment must be 5 MiB or smaller.');
    }
    if (data.length === 0 || data.length % 4 !== 0) {
        throw new Error('Image attachment data is not canonical base64.');
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const contentLength = data.length - padding;
    for (let index = 0; index < contentLength; index++) {
        const code = data.charCodeAt(index);
        const valid = (code >= 0x41 && code <= 0x5a)
            || (code >= 0x61 && code <= 0x7a)
            || (code >= 0x30 && code <= 0x39)
            || code === 0x2b
            || code === 0x2f;
        if (!valid) throw new Error('Image attachment data is not canonical base64.');
    }
    for (let index = contentLength; index < data.length; index++) {
        if (data.charCodeAt(index) !== 0x3d) throw new Error('Image attachment data is not canonical base64.');
    }
    const decodedLength = (data.length / 4) * 3 - padding;
    if (decodedLength > MAX_PROMPT_IMAGE_BYTES) {
        throw new Error('Each image attachment must be 5 MiB or smaller.');
    }
    if ((padding === 1 && contentLength % 4 !== 3) || (padding === 2 && contentLength % 4 !== 2)) {
        throw new Error('Image attachment data is not canonical base64.');
    }
    const decoded = Buffer.from(data, 'base64');
    if (decoded.toString('base64') !== data) {
        throw new Error('Image attachment data is not canonical base64.');
    }
    return decoded;
}

function isPromptImageMimeType(value: unknown): value is PromptImageMimeType {
    return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

function matchesMagicBytes(mimeType: PromptImageMimeType, data: Buffer): boolean {
    if (mimeType === 'image/png') {
        return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mimeType === 'image/jpeg') {
        return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    }
    return data.length >= 12
        && data.subarray(0, 4).toString('ascii') === 'RIFF'
        && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

function validateAttachmentName(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const name = value.trim();
    if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('Image attachment name is invalid.');
    }
    return name;
}
