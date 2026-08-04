# Native unsigned preview builders

These scripts reproduce the release-blocking Linux x64 and Windows x64 preview jobs on dedicated native hosts. They do not contain SSH details, credentials, signing material, or GitHub publishing logic.

Both builders:

1. verify a deterministic `git archive` by its caller-supplied SHA-256 and full commit, then confirm the uploaded builder and tool lock exactly match the committed copies;
2. install or verify the versions in `native-preview-tools.lock.json` (Node.js 24, Yarn Classic 1.22.22, Rust 1.92.0, DotSlash 0.5.7, and protoc 29.3);
3. build Grok Build from the pinned upstream commit on the native host;
4. run ACP smoke tests, metadata checks, all workspace tests, and Grok release-safety tests;
5. build unsigned preview installers, generate the pinned Syft CycloneDX SBOM, and verify every checksum and provenance field; and
6. produce a flat asset bundle, an outer SHA-256 file, a non-sensitive build report, and a local build log.

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

Language plugins are an audited local release input because the plugin staging
directory is intentionally not part of the source archive. Transfer one verified
plugin bundle to every native builder, compare its SHA-256 before extraction, and
record that digest in the build log. Published extension source maps are excluded:
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

## Linux x64

Host prerequisites are `curl`, `git`, `python3`, `rustup`, a C/C++ toolchain, `make`, `tar`, `unzip`, and `xz`. Use a new, short work directory for every attempt:

```bash
bash ./native-preview-linux-x64.sh \
  --source-archive /tmp/xora-code-0123456789abcdef0123456789abcdef01234567.tar.gz \
  --source-sha256 <archive-sha256> \
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

Do not reuse a previous source extraction or `node_modules` directory as the build
work tree. Pass a new, short `--work-root`/`-WorkRoot` on every attempt. The scripts
verify cached archives against `native-preview-tools.lock.json`; a mismatched archive
is rejected instead of being trusted.

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
scp xora-code-<commit>.tar.gz \
    native-preview-linux-x64.sh native-preview-tools.lock.json \
    <linux-builder>:/tmp/xora-input-<short-commit>/
```

```powershell
# Run from the coordinator with OpenSSH scp; credentials remain outside the repo.
scp xora-code-<commit>.tar.gz native-preview-windows-x64.ps1 `
    native-preview-tools.lock.json <windows-builder>:C:/xora-input/<short-commit>/
```

If the committed source archive intentionally omits the generated `plugins/`
directory, create one plugin archive locally, hash it once, and copy those exact
bytes to both builders. Extract it only under the fresh source root and refuse the
build when the remote digest differs. Never reuse a mutable plugin directory from
an older work tree.

After transfer, compare the remote source archive SHA-256 with the coordinator's
digest before invoking either builder. Build host addresses, passwords, private keys,
proxy URLs and signing material must never be written to this repository.

## Remote build and artifact return checklist

1. Commit and test a clean release candidate.
2. Generate one deterministic `git archive`; use the same bytes on every host.
3. Inventory and reuse only the verified caches listed above.
4. Start each native builder in a new work root and retain its log.
5. Pull the outer bundle, `.sha256.txt` and `.build.json` to the coordinator.
6. Verify the outer digest, safely extract the bundle, and rerun
   `build/sbom/verify-preview-assets.mjs` locally.
7. Compare installer architecture, embedded Grok target, version and commit metadata.
8. Generate a combined `SHA256SUMS.txt` before publishing any asset.
9. Publish the immutable Git tag and GitHub Release, then mirror the same verified
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
