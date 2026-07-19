# SBOM release gate

Signed releases require `sbom.cdx.json`, generated from the final packaged application and sidecar on the native CI runner. This marker is not an SBOM and must not satisfy the Release credential/compliance gate.
