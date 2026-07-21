# Packaged legal inventory

This directory is shipped outside ASAR under `legal/upstream/`. The pinned Grok Build license and notice files live in `grok-build/`; release-gate documentation lives alongside them.

The generated CycloneDX SBOM is intentionally not stored in this directory or assumed to be embedded in the application. Native builders use the pinned Anchore Syft assets and digests in `build/sbom/syft.lock.json` to generate a target-specific `.cdx.json` file after packaging. The document combines a scan of the unpacked application payload with a conservative scan of the exact committed dependency tree, labelled `packaged-payload-plus-locked-build-dependencies`, because ASAR archives and stripped Rust executables do not expose a complete inventory to Syft. Builders publish that SBOM as a separate Release asset alongside the installers and checksums.

The source of truth is Grok Build public commit `98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce`. Release verification must fail closed if these files do not match that checkout.
