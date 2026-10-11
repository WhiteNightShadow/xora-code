import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { OfficialGrokSource, OfficialGrokUpdater, extractOfficialGrok, type OfficialGrokRelease } from '../official-grok-update.js';
import { SidecarInstaller, type InstalledSidecarRelease } from '../sidecar-update-manager.js';

function tar(entries: { name: string; data: Buffer; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(entry.data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(entry.type ?? '0', 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, entry.data, Buffer.alloc((512 - entry.data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const binary = Buffer.from('official Grok binary');
const archive = tar([{ name: 'package/bin/grok.br', data: brotliCompressSync(binary) }, { name: 'package/package.json', data: Buffer.from('{}') }, { name: 'package/THIRD_PARTY_NOTICES.md', data: Buffer.from('Official notices') }]);
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
const release: OfficialGrokRelease = { version: '1.0.46', target: 'darwin-arm64', packageName: '@xai-official/grok-darwin-arm64', tarball: 'https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.46.tgz', integrity };

function source(replies: unknown[], calls: { url: string; init: RequestInit | undefined }[] = []): OfficialGrokSource {
  return new OfficialGrokSource((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return new Response(reply instanceof Buffer ? reply : JSON.stringify(reply), { status: 200 });
  }) as typeof fetch);
}
function metadata(): unknown[] {
  return [{ name: '@xai-official/grok', version: '1.0.46', optionalDependencies: { [release.packageName]: '1.0.46' } },
    { name: release.packageName, version: '1.0.46', os: ['darwin'], cpu: ['arm64'], dist: { tarball: release.tarball, integrity } }];
}

test('official discovery pins the package, stable version, target, HTTPS registry and SHA-512', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  assert.deepEqual(await source(metadata(), calls).latest('darwin-arm64'), release);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.init?.redirect === 'error'));
  await assert.rejects(source([]).latest('freebsd-x64'), /未支持/);
  for (const bad of ['https://evil.example/grok.tgz', 'http://registry.npmjs.org/grok.tgz', 'https://registry.npmjs.org/@other/grok.tgz']) {
    const replies = metadata() as any[]; replies[1].dist.tarball = bad;
    await assert.rejects(source(replies).latest(release.target), /下载地址/);
  }
  for (const patch of [{ version: '1.0.45' }, { name: '@other/grok' }, { os: ['win32'] }, { cpu: ['x64'] }, { dist: { tarball: release.tarball } }]) {
    const replies = metadata() as any[]; Object.assign(replies[1], patch);
    await assert.rejects(source(replies).latest(release.target));
  }
});

test('offline metadata check fails without an installed-state write', async () => {
  await assert.rejects(source([new Error('offline')]).latest(release.target), /offline/);
});

test('download rejects tampering and extracts Brotli executable without install scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xora-official-test-'));
  try {
    const downloaded = join(root, 'official.tgz');
    await source([archive]).download(release, downloaded);
    const executable = join(root, 'grok'); await extractOfficialGrok(downloaded, executable, 'grok');
    assert.deepEqual(await readFile(executable), binary);
    assert.equal((await readFile(join(root, 'THIRD_PARTY_NOTICES.md'))).toString(), 'Official notices');
    assert.ok(!(await readdir(root)).some(name => name.endsWith('.br')));
    await assert.rejects(source([Buffer.from('truncated')]).download(release, join(root, 'bad.tgz')), /SHA-512/);
    await assert.rejects(source([]).download({ ...release, tarball: 'https://evil.example/a' }, join(root, 'unsafe')), /来源/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tar traversal, links, duplicate binaries and truncated input are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xora-official-tar-'));
  try {
    for (const [index, entries] of [
      [{ name: 'package/../../escape', data: binary }],
      [{ name: 'package/bin/grok', data: binary, type: '2' }],
      [{ name: 'package/bin/grok', data: binary }, { name: 'package/bin/grok', data: binary }],
      [{ name: 'package/README.md', data: binary }],
    ].entries()) {
      const file = join(root, `bad-${index}.tgz`); await writeFile(file, tar(entries));
      await assert.rejects(extractOfficialGrok(file, join(root, `binary-${index}`), 'grok'));
    }
    await writeFile(join(root, 'truncated.tgz'), archive.subarray(0, archive.length - 8));
    await assert.rejects(extractOfficialGrok(join(root, 'truncated.tgz'), join(root, 'truncated'), 'grok'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(failure?: 'version' | 'acp' | 'activation') {
  const root = await mkdtemp(join(tmpdir(), 'xora-official-install-'));
  const installer = new SidecarInstaller(root, { activationHook: phase => { if (failure === 'activation' && phase === 'after-promote-candidate') throw new Error('activation rejected'); } });
  await mkdir(installer.embeddedPath); await writeFile(join(installer.embeddedPath, 'grok'), 'embedded');
  const embedded: InstalledSidecarRelease = { version: '0.2.102', sequence: 0, channel: 'stable', target: release.target,
    artifactSha256: sha(Buffer.from('embedded')), artifactSize: 8, sidecarLockSha256: 'a'.repeat(64), patchSha256: 'b'.repeat(64),
    acpFixtureSha256: 'c'.repeat(64), homeCompatEpoch: 1, installedAt: '2026-07-19T00:00:00Z' };
  const updater = new OfficialGrokUpdater({ installer, embedded, source: source([archive, archive, archive]),
    verifyVersion: async (file, version) => { assert.equal(version, '1.0.46'); assert.deepEqual(await readFile(file), binary); if (failure === 'version') throw new Error('version rejected'); },
    verifyAcp: async () => { if (failure === 'acp') throw new Error('ACP rejected'); } });
  return { root, installer, updater, embedded };
}

test('install, repeat check, rollback and re-install preserve binary hashes and anti-downgrade floor', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.updater.apply(release)).status, 'installed');
    assert.deepEqual(await readFile(join(f.installer.activePath, 'grok')), binary);
    assert.equal((await f.updater.apply(release)).status, 'up-to-date');
    assert.equal((await f.installer.rollbackToPrevious(f.embedded)).version, '0.2.102');
    assert.equal((await f.installer.readState(f.embedded)).officialHighWater?.version, '1.0.46');
    await assert.rejects(f.updater.apply({ ...release, version: '1.0.45' }), /旧版本/);
    await assert.rejects(f.updater.apply({ ...release, integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') }), /内容发生变化/);
    assert.equal((await f.updater.apply(release)).status, 'installed');
    await writeFile(join(f.installer.activePath, 'grok'), 'tampered');
    await assert.rejects(f.updater.apply(release), /校验失败/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ['version', 'acp', 'activation'] as const) {
  test(`failed ${failure} leaves embedded binary, state and staging unchanged`, async () => {
    const f = await fixture(failure);
    try {
      await assert.rejects(f.updater.apply(release));
      assert.equal((await readFile(join(f.installer.embeddedPath, 'grok'))).toString(), 'embedded');
      const state = await f.installer.readState(f.embedded); assert.equal(state.active, undefined); assert.equal(state.highestSequence, 0);
      assert.deepEqual(await readdir(join(f.root, '.staging')), []);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('concurrent activation is excluded by the shared installation lock', async () => {
  const f = await fixture();
  try {
    await f.installer.withUpdateLock(async () => { await assert.rejects(f.updater.apply(release), /already running/); });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a dead updater lease and a legacy dead PID file can be recovered without touching a live owner', async () => {
  const f = await fixture();
  try {
    const lock = join(f.root, '.update.lock');
    await mkdir(lock); await writeFile(join(lock, `2147483647-${randomUUID()}.owner`), '{}');
    await f.installer.withUpdateLock(async () => { assert.equal((await readFile(lock)).toString(), `${process.pid}\n`); });
    await writeFile(lock, '2147483647\n');
    await f.installer.withUpdateLock(async () => { await assert.rejects(f.installer.withUpdateLock(async () => undefined), /already running/); });
    await writeFile(lock, `${process.pid}\n`);
    await assert.rejects(f.installer.withUpdateLock(async () => undefined), /already running/);
    assert.equal((await readFile(lock)).toString(), `${process.pid}\n`);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('a live directory lease protects the interval before the compatibility PID file is written', async () => {
  const f = await fixture();
  try {
    const lease = join(f.root, '.update.lease'); await mkdir(lease);
    const marker = `${process.pid}-${randomUUID()}.owner`; await writeFile(join(lease, marker), '{}');
    await assert.rejects(f.installer.withUpdateLock(async () => undefined), /already running/);
    assert.equal((await readFile(join(lease, marker))).toString(), '{}');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
