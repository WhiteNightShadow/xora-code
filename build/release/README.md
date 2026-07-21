# Native unsigned preview builders

These scripts reproduce the release-blocking Linux x64 and Windows x64 preview jobs on dedicated native hosts. They do not contain SSH details, credentials, signing material, or GitHub publishing logic.

Both builders:

1. verify a deterministic `git archive` by its caller-supplied SHA-256 and full commit, then confirm the uploaded builder and tool lock exactly match the committed copies;
2. install or verify the versions in `native-preview-tools.lock.json` (Node.js 24, Yarn Classic 1.22.22, Rust 1.92.0, DotSlash 0.5.7, and protoc 29.3);
3. build Grok Build from the pinned upstream commit on the native host;
4. run ACP smoke tests, metadata checks, all workspace tests, and Grok release-safety tests;
5. build unsigned preview installers, generate the pinned Syft CycloneDX SBOM, and verify every checksum and provenance field; and
6. produce a flat asset bundle, an outer SHA-256 file, a non-sensitive build report, and a local build log.

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

## Publication boundary

The output is intentionally unsigned preview material. These scripts never create a release, update a mutable tag, or claim production signing. Pull the bundle, `.sha256.txt`, and `.build.json` back to the trusted coordinator; verify the outer digest, safely extract it, run `build/sbom/verify-preview-assets.mjs` again, and only then upload the individual preview assets to an immutable GitHub prerelease.

If a build fails, use a new `--work-root`. Verified download archives and language package caches are reused, while executable Node.js, DotSlash, and protoc trees are freshly extracted or built inside each work root. Mismatched cached archives are rejected instead of silently replaced.
