# Native unsigned preview builders

These scripts reproduce the release-blocking Linux x64 and Windows x64 preview jobs on dedicated native hosts. They do not contain SSH details, credentials, signing material, or GitHub publishing logic.

Both builders:

1. verify a deterministic `git archive` by its caller-supplied SHA-256 and full commit, then confirm the uploaded builder and tool lock exactly match the committed copies;
2. require one independently hashed language-plugin seed, reject links, path traversal, cross-platform ambiguous names and source maps, and extract it only into the fresh `source/plugins` directory;
3. install or verify the versions in `native-preview-tools.lock.json` (Node.js 24, Yarn Classic 1.22.22, Rust 1.92.0, DotSlash 0.5.7, and protoc 29.3);
4. build Grok Build from the pinned upstream commit on the native host;
5. run ACP smoke tests, metadata checks, all workspace tests, and Grok release-safety tests;
6. build unsigned preview installers, generate the pinned Syft CycloneDX SBOM, and verify every checksum and provenance field; and
7. produce a flat asset bundle, an outer SHA-256 file, a non-sensitive build report (including `pluginArchiveSha256`), and a local build log.

The Windows build also applies the audited build-only compatibility patch listed
in `build/grok/PATCHES.md`. Its SHA-256 is pinned in `sidecar.lock.json`, and the
builder refuses to apply it if either the upstream source or patch bytes differ.

The Grok and bundled ripgrep builds apply equivalent source-path remapping to
Rust and native C/C++ compilers. This covers dependency `__FILE__` strings as
well as Rust diagnostics; the release gate rejects any binary that still embeds
the runner home, work tree, Cargo cache, or Rustup cache path.

On Windows, the native remap includes MSVC deterministic mode because recent
toolchains otherwise accept but ignore `/pathmap`. Direct native compilation
uses `/Z7`; Windows native remapping deliberately leaves the work and target
output prefixes unmapped so CMake cannot rewrite its absolute `/Fd` PDB
destination into a virtual path. Source, Cargo, Rustup and home prefixes remain
mapped, Rust still receives the complete mapping set, and the final binaries
are scanned for every original prefix. The pinned AWS-LC dependency is built
through CMake so its byte-swap feature probe is link-checked instead of being
accepted at compile time and failing during the final Grok link.

The dependency SBOM scan excludes `applications/electron/dist/**`: installers
are generated outputs, while the unpacked payload is already scanned through a
separate validated root. This prevents Syft from cataloguing the same Linux deb
package more than once when AppImage and deb artifacts coexist in `dist/`.

Language plugins are a required, audited local release input because the generated
plugin staging directory is intentionally not part of the source archive. Transfer
one verified gzip-compressed tar bundle to every native builder. The builders compare
its SHA-256 before extraction and record that digest in both the build log and build
report. Published extension source maps are rejected:
they are not required at runtime and commonly retain upstream CI paths. The
`afterPack` release gate scans every regular file in the unpacked application;
compressed installer bytes are validated structurally and by checksum rather than
searched as text, avoiding false positives from compression entropy.

## Prepare one immutable source archive

Run this only from a clean local Git worktree after the release candidate has been committed:

```bash
commit="$(git rev-parse HEAD)"
git archive --format=tar --prefix="xora-code-$commit/" "$commit" | gzip -n > "/tmp/xora-code-$commit.tar.gz"
shasum -a 256 "/tmp/xora-code-$commit.tar.gz"
```

Transfer that exact archive, its digest, and the three build inputs in this directory (the two native scripts and their tool lock) to each native host. Never rebuild the archive separately per host.

## Prepare one immutable plugin seed

Create this archive once on the trusted coordinator after `yarn download:plugins` and
`yarn ensure:plugins` pass. The archive must have one `plugins/` root, contain only
regular files and directories, and contain no `*.map` files. The release extractor
also rejects links, path traversal, case-colliding paths and Windows-ambiguous names.

```bash
commit="$(git rev-parse HEAD)"
plugin_stage="$(mktemp -d)"
mkdir -p "$plugin_stage/plugins"
rsync -a --exclude='.gitkeep' --exclude='*.map' plugins/ "$plugin_stage/plugins/"
find "$plugin_stage/plugins" -type f -iname '*.map' -delete
COPYFILE_DISABLE=1 tar -C "$plugin_stage" -czf "/tmp/xora-code-plugins-$commit.tar.gz" plugins
shasum -a 256 "/tmp/xora-code-plugins-$commit.tar.gz"
rm -rf "$plugin_stage"
```

Use the exact same plugin archive bytes and lowercase SHA-256 on Linux and Windows.
The seed is required even when a previous build image already contains a mutable
`plugins/` directory; cached or work-tree plugin directories are never trusted.

## Linux x64

Host prerequisites are `curl`, `git`, `python3`, `rustup`, a C/C++ toolchain, `make`, `tar`, `unzip`, and `xz`. Use a new, short work directory for every attempt:

```bash
bash ./native-preview-linux-x64.sh \
  --source-archive /tmp/xora-code-0123456789abcdef0123456789abcdef01234567.tar.gz \
  --source-sha256 <archive-sha256> \
  --plugin-archive /tmp/xora-code-plugins-0123456789abcdef0123456789abcdef01234567.tar.gz \
  --plugin-sha256 <plugin-archive-sha256> \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --work-root /tmp/xora-linux-0123456789ab \
  --output-dir /tmp/xora-output
```

## Windows x64

The Windows host must already have Git, Python, rustup, and Visual Studio 2022 C++ Build Tools. Run from 64-bit Windows PowerShell 5.1 or later, using a short work path:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native-preview-windows-x64.ps1 `
  -SourceArchive C:\xora-input\xora-code-0123456789abcdef0123456789abcdef01234567.tar.gz `
  -SourceSha256 <archive-sha256> `
  -PluginArchive C:\xora-input\xora-code-plugins-0123456789abcdef0123456789abcdef01234567.tar.gz `
  -PluginSha256 <plugin-archive-sha256> `
  -Commit 0123456789abcdef0123456789abcdef01234567 `
  -WorkRoot C:\xora\0123456789ab `
  -OutputDirectory C:\xora-output
```

## Reusing a prepared build image

The native builders are designed to reuse verified download and package caches while
creating a fresh executable work tree for every build. A cloned build image may keep
the following directories between runs:

| Host | Reusable cache | Contents |
| --- | --- | --- |
| Linux | `~/.cache/xora-code/native-preview-tools` | Node, Electron, protoc, Syft, Cargo registry/git data, npm and Yarn downloads |
| Linux | `~/.rustup` | The pinned Rust toolchain |
| Windows | `C:\xora-build-tools\native-cache` | Node, Electron, protoc, Syft, Cargo registry/git data, npm and Yarn downloads |
| Windows | `%USERPROFILE%\.rustup` | The pinned Rust toolchain |

Treat an image as a cache carrier, not as proof that a release is ready to resume.
Before doing any compilation, classify what the image actually contains:

1. **Tool installations** — Git, Python, Rustup and Visual Studio Build Tools.
2. **Verified download caches** — pinned Node/Electron/protoc/Syft archives, Yarn/npm
   packages and Cargo registry/git objects.
3. **Platform build prerequisites** — Windows-only optional Node packages, Electron
   headers and the MSVC Spectre libraries required by the selected toolset.
4. **Reusable native outputs** — a Cargo target tree and, preferably, a staged Grok
   sidecar whose binary, notices, `release.json` and ACP smoke result all verify.
5. **Disposable release outputs** — application bundles, installers and SBOMs. These
   are never accepted just because they exist on the image.

The distinction matters: a multi-gigabyte Cargo cache avoids downloads, but a forced
checkout can still invalidate timestamps and cause a full native relink. Conversely,
a verified staged sidecar lets a UI-only release continue directly with the Electron
build without rebuilding Grok.

Do not reuse a previous source extraction or `node_modules` directory as the build
work tree. Pass a new, short `--work-root`/`-WorkRoot` on every attempt. The scripts
verify cached archives against `native-preview-tools.lock.json`; a mismatched archive
is rejected instead of being trusted.

DotSlash installation is offline-first. A complete isolated Cargo cache is reused
without contacting the registry; only an incomplete cache falls back to the locked
official crates.io sparse index. This keeps cloned build images fast while retaining
the same pinned version and post-install version verification.

The pinned source builds of ripgrep and Grok use the same offline-first policy. A
fresh image still falls back to the configured locked registry, while a cloned image
can complete those native stages from its verified Cargo cache even when the Windows
certificate-revocation service or the public index is temporarily unavailable.

The disposable Grok checkout overrides host Git line-ending preferences with
`core.autocrlf=false` and `core.eol=lf`, then performs a forced detached checkout.
This keeps upstream LICENSE and notice bytes identical on Windows and prevents a
previous failed attempt from leaking patched worktree state into a retry.

Before fetching the pinned upstream commit, retries use `git cat-file` to verify
whether that exact commit object is already present in the isolated checkout. A
verified object is reused and still passes SOURCE_REV/toolchain checks; only a
missing object triggers the network fetch.

The audited upstream license and notice paths are then materialized as raw bytes
from that verified commit object. This avoids Git for Windows retaining CRLF in
an already-created worktree after a host line-ending preference changes, while
the release gate continues comparing those bytes with the committed legal set.

Before starting a remote build, inventory the image rather than reinstalling tools:

```bash
# Linux
du -sh ~/.cache/xora-code/native-preview-tools ~/.rustup 2>/dev/null || true
find ~/.cache/xora-code/native-preview-tools -maxdepth 2 -type f -print
```

```powershell
# Windows
$roots = @('C:\xora-build-tools\native-cache', "$env:USERPROFILE\.rustup")
$roots | Where-Object { Test-Path $_ } | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum
}
```

## Seeding a slow or offline remote host

When a build host cannot reliably reach an upstream CDN, download the exact asset on
the trusted coordinator, verify its size and SHA-256 from
`native-preview-tools.lock.json`, and copy it into the cache path above. Never seed an
unversioned URL or an archive without a pinned digest. Typical large assets are the
platform-specific Electron archive, Node archive, protoc and Syft.

Transfer the immutable source archive and build inputs separately from the cache:

```bash
scp xora-code-<commit>.tar.gz xora-code-plugins-<commit>.tar.gz \
    native-preview-linux-x64.sh native-preview-tools.lock.json \
    <linux-builder>:/tmp/xora-input-<short-commit>/
```

```powershell
# Run from the coordinator with OpenSSH scp; credentials remain outside the repo.
scp xora-code-<commit>.tar.gz xora-code-plugins-<commit>.tar.gz native-preview-windows-x64.ps1 `
    native-preview-tools.lock.json <windows-builder>:C:/xora-input/<short-commit>/
```

The generated `plugins/` payload is always supplied through the required plugin seed.
The tracked `plugins/.gitkeep` placeholder is removed only after the complete archive
passes validation. Extraction refuses to replace any other pre-existing content and
can only write beneath the fresh source tree's `plugins/` directory.

After transfer, compare the remote source archive SHA-256 with the coordinator's
digest before invoking either builder. Build host addresses, passwords, private keys,
proxy URLs and signing material must never be written to this repository.

### Preflight before the expensive native build

Run the preflight before invoking the Grok builder. A missing platform dependency
must be repaired first; discovering it after a native link wastes the slowest part of
the job.

- Verify the source archive, plugin archive and every locally seeded package by hash.
- Verify Node, Yarn, Electron, Rust, Cargo, protoc and Syft versions without installing
  them again.
- Confirm the exact Grok commit object and Cargo registry/git cache are present.
- On Windows, resolve the lockfile on Windows and confirm platform-only optional
  packages such as `@vscode/windows-ca-certs` are available in the npm/Yarn cache.
  A dependency tree created on macOS or Linux is not a valid Windows dependency tree.
- On Windows, verify the active MSVC toolset has the x64 Spectre libraries when a
  native addon requests `SpectreMitigation`. For MSVC 14.44 this is the official
  component `Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre`.
- Verify the Electron headers and native-addon toolchain with a small rebuild before
  starting Grok.
- If a staged sidecar exists, verify its hash, target, metadata, legal files and ACP
  initialization. Reuse it only when all of those checks pass.

When the remote network is slow, download the exact npm tarball or Microsoft VSIX on
the coordinator, verify it against the lockfile or official Visual Studio catalog,
and transfer those immutable bytes. For a VSIX, install only the component files for
the active toolset and architecture; do not copy an entire unverified Visual Studio
tree. Record the URL, version, size and digest in the private build log, not in product
configuration.

### Resume policy

Resume from the latest verified boundary rather than restarting the full script:

| Verified boundary | Resume action |
| --- | --- |
| Downloads only | Fresh source tree, native build still required |
| Cargo target plus exact Grok source/flags | Resume Cargo build; expect relink if timestamps or flags changed |
| Staged Grok sidecar plus metadata/notices/ACP smoke | Skip Grok; build/test/package Electron |
| Verified unpacked application | Generate installers and SBOM only |
| Verified flat artifact bundle | Return to coordinator; do not rebuild |

Never reuse an executable merely because its filename and version look correct. Every
resume boundary is content-addressed and must pass the same release gates as a fresh
build. Store a new output directory for each resume attempt so failed outputs cannot
be mistaken for completed artifacts.

## Remote build and artifact return checklist

1. Commit and test a clean release candidate.
2. Generate one deterministic `git archive`; use the same bytes on every host.
3. Run the platform preflight and inventory all five cache/output layers above.
4. Seed missing locked assets from the coordinator before starting compilation.
5. Reuse the newest verified boundary; do not rerun Grok after a verified sidecar.
6. Start each remaining stage in a new work/output root and retain its log.
7. Pull the outer bundle, `.sha256.txt` and `.build.json` to the coordinator.
8. Verify the outer digest, safely extract the bundle, and rerun
   `build/sbom/verify-preview-assets.mjs` locally.
9. Compare installer architecture, embedded Grok target, version and commit metadata.
10. Generate a combined `SHA256SUMS.txt` before publishing any asset.
11. Publish the immutable Git tag and GitHub Release, then mirror the same verified
   files and checksum document to the website download service.

If a remote download repeatedly stalls, stop that attempt and seed only the missing
locked asset from the coordinator. Do not switch to an arbitrary mirror without
updating the lock and reviewing its provenance.

Puppeteer and Playwright browser payloads are intentionally skipped by both native
builders. They are transitive development dependencies, are not included in the
desktop application, and must not make a release depend on a multi-hundred-megabyte
browser download. The Electron runtime used by the product remains locked and
verified independently.

## Publication boundary

The output is intentionally unsigned preview material. These scripts never create a release, update a mutable tag, or claim production signing. Pull the bundle, `.sha256.txt`, and `.build.json` back to the trusted coordinator; verify the outer digest, safely extract it, run `build/sbom/verify-preview-assets.mjs` again, and only then upload the individual preview assets to an immutable GitHub prerelease.

If a build fails, use a new `--work-root`. Verified download archives and language package caches are reused, while executable Node.js, DotSlash, and protoc trees are freshly extracted or built inside each work root. Mismatched cached archives are rejected instead of silently replaced.
