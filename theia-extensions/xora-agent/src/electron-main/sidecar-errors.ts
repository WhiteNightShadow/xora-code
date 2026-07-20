export const GROK_SIDECAR_MISSING_MESSAGE =
    '当前安装未包含 Grok Build 0.2.102 组件，无法登录或启动 Agent。请使用包含该组件的完整构建；开发模式可设置 XORA_GROK_BINARY 后重启。';

export const GROK_SIDECAR_INACCESSIBLE_MESSAGE =
    '无法访问 Grok Build 组件，无法登录或启动 Agent。请检查应用文件权限，或重新安装 Xora Code。';

/**
 * Convert filesystem failures into stable renderer-safe messages. In
 * particular, Node's ENOENT text contains the absolute application path and
 * is neither useful nor appropriate to expose in a desktop notification.
 */
export function sidecarFilesystemError(error: unknown): Error {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
        return new Error(GROK_SIDECAR_MISSING_MESSAGE);
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return new Error(GROK_SIDECAR_INACCESSIBLE_MESSAGE);
    }
    return new Error('无法校验 Grok Build 组件。请重新安装 Xora Code 后重试。');
}
