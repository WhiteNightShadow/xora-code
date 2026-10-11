import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createBrotliDecompress, createGunzip } from 'node:zlib';
import { compareSemver } from './manifest.js';
import {
  SidecarActivationError, SidecarInstaller, SidecarUpdateError,
  type InstalledSidecarRelease, type SidecarUpdateResult,
} from './sidecar-update-manager.js';

const REGISTRY = 'https://registry.npmjs.org';
const VERSION = /^\d+\.\d+\.\d+$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);

export interface OfficialGrokRelease {
  version: string;
  target: string;
  packageName: string;
  tarball: string;
  integrity: string;
}

/** Upstream npm distribution. This is separate from Xora's Ed25519 release channel. */
export class OfficialGrokSource {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async metadata(url: string): Promise<Record<string, any>> {
    const response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`官方 Grok 版本查询失败（HTTP ${response.status}）。请检查网络后重试。`);
    if (!response.body) throw new Error('官方版本源返回空响应。');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 1024 * 1024) throw new Error('官方版本元数据超过大小限制。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('官方版本元数据格式无效。');
    return parsed as Record<string, any>;
  }

  async latest(target: string): Promise<OfficialGrokRelease> {
    if (!TARGETS.has(target)) throw new Error(`官方 Grok 未支持此平台：${target}。`);
    const main = await this.metadata(`${REGISTRY}/@xai-official/grok/latest`);
    if (main.name !== '@xai-official/grok' || typeof main.version !== 'string' || !VERSION.test(main.version)) {
      throw new Error('官方稳定版本号无效。');
    }
    const packageName = `@xai-official/grok-${target}`;
    if (main.optionalDependencies?.[packageName] !== main.version) throw new Error(`官方最新版本暂未提供 ${target} 安装包。`);
    const platform = await this.metadata(`${REGISTRY}/${packageName}/${main.version}`);
    const [os, cpu] = target.split('-');
    if (platform.name !== packageName || platform.version !== main.version ||
        !Array.isArray(platform.os) || !platform.os.includes(os) || !Array.isArray(platform.cpu) || !platform.cpu.includes(cpu)) {
      throw new Error('官方安装包的平台或版本不匹配。');
    }
    const expectedUrl = `${REGISTRY}/${packageName}/-/grok-${target}-${main.version}.tgz`;
    if (platform.dist?.tarball !== expectedUrl || typeof platform.dist?.integrity !== 'string' || !INTEGRITY.test(platform.dist.integrity)) {
      throw new Error('官方安装包缺少有效的 SHA-512 校验或下载地址。');
    }
    return { version: main.version, target, packageName, tarball: expectedUrl, integrity: platform.dist.integrity };
  }

  async download(release: OfficialGrokRelease, destination: string, signal?: AbortSignal): Promise<void> {
    // Never consume an arbitrary URL supplied by a renderer or local state.
    if (!TARGETS.has(release.target) || !VERSION.test(release.version) || !INTEGRITY.test(release.integrity) ||
        release.tarball !== `${REGISTRY}/@xai-official/grok-${release.target}/-/grok-${release.target}-${release.version}.tgz`) {
      throw new Error('官方 Grok 下载来源无效。');
    }
    const response = await this.request(release.tarball, { redirect: 'error', signal: signal ?? AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`官方 Grok 下载失败（HTTP ${response.status}）。`);
    const file = await open(destination, 'wx', 0o600);
    const hash = createHash('sha512');
    const reader = response.body.getReader();
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_DOWNLOAD) throw new Error('官方 Grok 安装包超过大小限制。');
        hash.update(value);
        await file.writeFile(value);
      }
      await file.sync();
    } finally { await file.close(); await reader.cancel().catch(() => undefined); }
    if (!length || `sha512-${hash.digest('base64')}` !== release.integrity) throw new SidecarUpdateError('integrity', '官方 Grok 安装包 SHA-512 校验失败。原版本未更改。');
  }
}

/** Extract the native executable and its notices; never execute package scripts. */
export async function extractOfficialGrok(archive: string, destination: string, binaryName: string): Promise<void> {
  const source = createReadStream(archive);
  const gunzip = createGunzip();
  source.on('error', error => gunzip.destroy(error));
  source.pipe(gunzip);
  let buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let total = 0;
  let writing = false;
  let found = false;
  let ended = false;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let compressed = false;
  const compressedPath = `${destination}.br`;
  try {
    for await (const bytes of gunzip) {
      const chunk = bytes as Buffer;
      total += chunk.length;
      if (total > MAX_EXPANDED) throw new Error('官方 Grok 解压数据超过大小限制。');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (remaining) {
          const count = Math.min(remaining, buffer.length);
          if (!count) break;
          if (writing) await file!.writeFile(buffer.subarray(0, count));
          remaining -= count; buffer = buffer.subarray(count);
          if (remaining) break;
          writing = false;
        }
        if (padding) {
          const count = Math.min(padding, buffer.length);
          padding -= count; buffer = buffer.subarray(count);
          if (padding) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) { ended = true; continue; }
        if (ended) throw new Error('官方 Grok 压缩包包含尾随条目。');
        const string = (start: number, size: number): string => header.subarray(start, start + size).toString('utf8').split('\0')[0]!;
        const octal = (start: number, size: number): number => {
          const text = string(start, size).trim();
          if (!/^[0-7]+$/u.test(text)) throw new Error('官方 Grok 压缩包包含无效数字。');
          const value = parseInt(text, 8);
          if (!Number.isSafeInteger(value) || value > MAX_EXPANDED) throw new Error('官方 Grok 压缩包条目过大。');
          return value;
        };
        const expected = octal(148, 8);
        const actual = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (expected !== actual) throw new Error('官方 Grok 压缩包头校验失败。');
        const prefix = string(345, 155);
        const name = (prefix ? `${prefix}/` : '') + string(0, 100);
        const type = string(156, 1);
        if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..') ||
            !name.startsWith('package/') || !['', '0', '5'].includes(type)) {
          throw new Error('官方 Grok 压缩包包含不支持或不安全的条目。');
        }
        remaining = octal(124, 12); padding = (512 - remaining % 512) % 512;
        const isBinary = name === `package/bin/${binaryName}` || name === `package/bin/${binaryName}.br`;
        const isNotice = name === 'package/THIRD_PARTY_NOTICES.md';
        if (isBinary || isNotice) {
          if (!['', '0'].includes(type) || (isBinary && (found || remaining === 0))) throw new Error('官方 Grok 可执行文件条目无效。');
          if (isNotice && remaining > 1024 * 1024) throw new Error('官方 Grok notices 超过大小限制。');
          await file?.sync(); await file?.close(); file = undefined;
          if (isBinary) { compressed = name.endsWith('.br'); found = true; }
          file = await open(isNotice ? join(dirname(destination), 'THIRD_PARTY_NOTICES.md') : compressed ? compressedPath : destination, 'wx', isNotice ? 0o600 : 0o755);
          writing = true;
        }
      }
    }
    if (!found || remaining || padding || buffer.some(byte => byte !== 0) || !ended) throw new Error('官方 Grok 压缩包不完整或缺少可执行文件。');
    await file!.sync();
  } finally { source.destroy(); gunzip.destroy(); await file?.close(); }
  if (compressed) {
    const input = createReadStream(compressedPath);
    const decoder = createBrotliDecompress();
    input.on('error', error => decoder.destroy(error)); input.pipe(decoder);
    const output = await open(destination, 'wx', 0o755);
    let expanded = 0;
    try {
      for await (const bytes of decoder) {
        expanded += bytes.length;
        if (expanded > MAX_EXPANDED) throw new Error('官方 Grok 可执行文件超过解压大小限制。');
        await output.writeFile(bytes);
      }
      if (!expanded) throw new Error('官方 Grok 可执行文件为空。');
      await output.sync();
    } finally { input.destroy(); decoder.destroy(); await output.close(); }
    await rm(compressedPath);
  }
}

export interface OfficialGrokUpdaterOptions {
  installer: SidecarInstaller;
  source: OfficialGrokSource;
  embedded: InstalledSidecarRelease;
  verifyVersion: (binary: string, version: string) => Promise<void>;
  verifyAcp: (binary: string) => Promise<void>;
  beforeActivate?: () => Promise<void>;
}

export class OfficialGrokUpdater {
  constructor(private readonly options: OfficialGrokUpdaterOptions) {}

  async apply(release: OfficialGrokRelease): Promise<SidecarUpdateResult> {
    const { installer, source, embedded } = this.options;
    return installer.withUpdateLock(async () => {
      const state = await installer.readState(embedded);
      const binaryName = embedded.target.startsWith('win32-') ? 'grok.exe' : 'grok';
      await installer.assertLayout(state, binaryName);
      if (release.target !== embedded.target || state.homeCompatEpoch !== embedded.homeCompatEpoch) throw new Error('Grok 更新平台或数据兼容记录不匹配。');
      const current = state.active ?? embedded;
      const highWater = state.officialHighWater;
      const floor = [current.version, state.previous?.version, highWater?.version].filter((v): v is string => !!v);
      if (floor.some(version => compareSemver(release.version, version) < 0)) throw new Error('官方版本源返回了旧版本，已拒绝降级。');
      if (highWater?.version === release.version && highWater.integrity !== release.integrity) throw new Error('官方同版本安装包内容发生变化，已拒绝更新。');
      if (current.version === release.version) {
        if (current.distributionIntegrity && current.distributionIntegrity !== release.integrity) throw new Error('已安装版本与官方同版本校验不一致。');
        if (await hashFile(join(state.active ? installer.activePath : installer.embeddedPath, binaryName)) !== current.artifactSha256) throw new Error('当前 Grok 安装包校验失败。');
        return { status: 'up-to-date', release: current };
      }
      const stage = await installer.createStage();
      let preserve = false;
      try {
        const archive = join(stage, 'official.tgz');
        await source.download(release, archive);
        const candidate = join(stage, 'candidate'); await mkdir(candidate, { mode: 0o700 });
        const binary = join(candidate, binaryName);
        await extractOfficialGrok(archive, binary, binaryName);
        await installer.assertStagedBinary(candidate, binaryName);
        await this.options.verifyVersion(binary, release.version);
        await this.options.verifyAcp(binary);
        const installed: InstalledSidecarRelease = {
          ...embedded, version: release.version, sequence: state.highestSequence + 1,
          artifactSha256: await hashFile(binary), artifactSize: (await stat(binary)).size,
          source: 'official-npm', distributionIntegrity: release.integrity,
          installedAt: new Date().toISOString(),
        };
        await installer.writeReleaseMetadata(candidate, installed);
        await this.options.beforeActivate?.();
        const nextState = {
          ...state, highestSequence: installed.sequence, active: installed,
          officialHighWater: { version: release.version, integrity: release.integrity },
          ...(state.active ? { previous: state.active } : {}),
        };
        if (!state.active) delete nextState.previous;
        await installer.activate(stage, candidate, state, nextState);
        return { status: 'installed', release: installed, ...(state.active ? { previous: state.active } : {}) };
      } catch (error) {
        if (error instanceof SidecarActivationError && !error.rollbackComplete) preserve = true;
        throw error;
      } finally { if (!preserve) await installer.discardStage(stage).catch(() => undefined); }
    });
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
