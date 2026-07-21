# SBOM release gate

Signed releases require a target-specific CycloneDX SBOM named `Xora-Code-<version>-<target>.cdx.json`. Native builders generate it after the application and sidecar have been packaged, then publish it as an independent Release asset alongside the installers and checksums.

Preview and remote native builds use Anchore Syft `1.48.0` from [`build/sbom/syft.lock.json`](../../build/sbom/syft.lock.json). The lock records the exact official asset URL and SHA-256 for macOS arm64/x64, Linux x64, and Windows x64. The Node wrapper verifies the archive, rejects unsafe archive paths and links, verifies `syft version`, invokes Syft without a shell, removes the native checkout root from the generated JSON, and adds the resulting SBOM digest to the target checksum file without duplicate entries:

```bash
yarn sbom:preview -- \
  --target linux-x64 \
  --cache-dir /absolute/path/to/pinned-tool-cache \
  --output-dir applications/electron/dist/preview-assets \
  --source-dir applications/electron/dist/linux-unpacked
```

Run the command only after `package:preview:installers`. The source directory must be electron-builder's unpacked application output; the generator verifies `app.asar`, the shipped Grok sidecar metadata/binary, and packaged legal inventory before scanning. Because Syft does not fully catalogue Electron ASAR or stripped Rust executables, the final document merges that payload scan with a conservative scan of the exact committed dependency tree and labels the scope as `packaged-payload-plus-locked-build-dependencies`. It also refuses to continue unless `SHA256SUMS-<target>.txt` already exists.

The generated SBOM is not required to be embedded in the application and must not be copied over this file. This marker is not an SBOM and cannot satisfy the Release credential or compliance gate.
