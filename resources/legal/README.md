# Packaged legal inventory

This directory is shipped outside ASAR. The pinned Grok Build license and notice files live in `grok-build/`; CI also places the generated CycloneDX SBOM here before a signed Release is packaged.

The source of truth is Grok Build public commit `98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce`. Release verification must fail closed if these files do not match that checkout.
