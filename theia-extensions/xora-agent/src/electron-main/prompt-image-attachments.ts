import * as crypto from 'crypto';
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
}

/**
 * Validates the renderer RPC boundary before any ACP request is created.
 * Standard canonical base64 is required so alternate encodings cannot bypass
 * byte limits or produce ambiguous hashes.
 */
export function validatePromptImageAttachments(value: unknown): ValidatedPromptImageAttachments {
    if (value === undefined) return { blocks: [], summaries: [] };
    if (!Array.isArray(value)) throw new Error('Image attachments must be an array.');
    if (value.length > MAX_PROMPT_IMAGE_COUNT) {
        throw new Error(`A prompt can contain at most ${MAX_PROMPT_IMAGE_COUNT} images.`);
    }

    const blocks: ValidatedPromptImageAttachments['blocks'] = [];
    const summaries: AgentAttachmentSummary[] = [];
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
        summaries.push({
            kind: 'image',
            mimeType: attachment.mimeType,
            byteSize: decoded.length,
            sha256: crypto.createHash('sha256').update(decoded).digest('hex'),
            ...(name ? { name } : {})
        });
    }
    return { blocks, summaries };
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
