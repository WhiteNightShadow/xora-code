import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RpcError, RpcErrorCode } from '@xora/protocol';
import { checkPathAccess, walk } from '@xora/tools';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
};

/** Resolves a path for the file preview, refusing anything outside the thread's workspace (10 §4). */
export async function resolveInside(root: string, target: string): Promise<string> {
    const absolute = path.isAbsolute(target) ? target : path.join(root, target);
    const access = await checkPathAccess([root], absolute);
    if (!access.ok) {
        throw new RpcError(RpcErrorCode.Rejected, `只能查看工作区里的文件：${target}`);
    }
    return access.realPath;
}

export async function readForPreview(root: string, target: string) {
    const file = await resolveInside(root, target);
    const info = await stat(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (info.size > MAX_PREVIEW_BYTES) {
        return { path: relative, kind: 'too_large' as const, size: info.size };
    }
    const bytes = await readFile(file);
    const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (mimeType) {
        return { path: relative, kind: 'image' as const, data: bytes.toString('base64'), mimeType, size: info.size };
    }
    if (bytes.subarray(0, 8000).includes(0)) {
        return { path: relative, kind: 'binary' as const, size: info.size };
    }
    return { path: relative, kind: 'text' as const, text: bytes.toString('utf8'), size: info.size };
}

export async function listForPreview(root: string, target = '.') {
    const dir = await resolveInside(root, target);
    const entries = await readdir(dir, { withFileTypes: true });
    const result = await Promise.all(
        entries
            .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
            .map(async (entry) => {
                const full = path.join(dir, entry.name);
                const size = entry.isFile() ? ((await stat(full).catch(() => undefined))?.size ?? 0) : 0;
                return {
                    name: entry.name,
                    path: path.relative(root, full).split(path.sep).join('/'),
                    dir: entry.isDirectory(),
                    size,
                };
            }),
    );
    return result.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** Writes an accepted inline edit, unless the file changed since the proposal was made. */
export async function applyInlineEdit(
    root: string,
    target: string,
    expectedOld: string,
    newText: string,
): Promise<void> {
    const file = await resolveInside(root, target);
    const current = await readFile(file, 'utf8');
    if (current !== expectedOld) {
        throw new RpcError(RpcErrorCode.Rejected, '文件在生成修改之后又被改过，请重新生成');
    }
    const temp = `${file}.xora-${process.pid}.tmp`;
    await writeFile(temp, newText, 'utf8');
    await rename(temp, file);
}

export const INLINE_EDIT_SYSTEM = `You rewrite one selected region of a file according to the user's instruction.
Reply with ONLY the replacement text for the selected region: no code fences, no explanations, no surrounding code.
Keep the file's indentation, style and language. If the instruction cannot be applied, return the selection unchanged.`;

export function inlineEditPrompt(
    file: string,
    content: string,
    start: number,
    end: number,
    instruction: string,
): string {
    const before = content.slice(Math.max(0, start - 20_000), start);
    const after = content.slice(end, end + 20_000);
    return `File: ${file}\n\n<before_selection>\n${before}\n</before_selection>\n<selection>\n${content.slice(start, end)}\n</selection>\n<after_selection>\n${after}\n</after_selection>\n\nInstruction: ${instruction}`;
}

/** Models sometimes wrap the answer in a fence anyway; unwrap a single surrounding one. */
export function unfence(text: string): string {
    const match = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
    return match?.[1] ?? text;
}

/** Files whose path contains the query characters in order, best (shortest, earliest) first. */
export async function findFiles(root: string, query: string, limit = 30): Promise<string[]> {
    const needle = query.toLowerCase();
    const scored: Array<{ path: string; score: number }> = [];
    let seen = 0;
    for await (const entry of walk(root)) {
        if (entry.kind !== 'file') continue;
        if (++seen > 50_000) break;
        const haystack = entry.relative.toLowerCase();
        let position = -1;
        let gaps = 0;
        let matched = true;
        for (const char of needle) {
            const next = haystack.indexOf(char, position + 1);
            if (next < 0) {
                matched = false;
                break;
            }
            gaps += next - position - 1;
            position = next;
        }
        if (!matched) continue;
        const nameBonus = entry.name.toLowerCase().includes(needle) ? -1000 : 0;
        scored.push({ path: entry.relative, score: nameBonus + gaps + entry.relative.length / 100 });
    }
    return scored
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map((item) => item.path);
}

const MENTION_LIMIT = 200 * 1024;

/** Reads a mentioned file for the prompt, if it is a reasonably small text file inside the workspace. */
export async function readMention(root: string, target: string): Promise<{ path: string; text: string } | undefined> {
    try {
        const preview = await readForPreview(root, target);
        if (preview.kind !== 'text' || preview.text === undefined || preview.size > MENTION_LIMIT) {
            return undefined;
        }
        return { path: preview.path, text: preview.text };
    } catch {
        return undefined;
    }
}
