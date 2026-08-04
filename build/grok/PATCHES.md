# Grok Build compatibility patches

Xora Code builds the pinned, public Grok Build source without runtime feature
forks. The following patch is limited to native build portability and is applied
only after the upstream commit and patch digest have both been verified.

## `windows-portable-protoc-output-v1`

- Applies to: `win32-x64` only.
- Upstream baseline: Grok Build `0.2.102`, commit
  `98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce`.
- Upstream location: `crates/build/xai-proto-build/src/lib.rs`, where protoc
  dependency output is directed to `/dev/stdout` and `/dev/null`.
- Reason: those Unix device paths do not exist for native Windows protoc 29.3,
  so the otherwise supported Windows source build exits before producing Grok.
- Change: write protoc's temporary dependency and descriptor output beneath
  Cargo's per-crate `OUT_DIR`, read the dependency file, then delete both files.
- Runtime impact: none; the patch only executes inside Rust build scripts.
- Upstream tracking: the pinned source line is the authoritative reference;
  no upstream issue has been filed by Xora Code.
- Removal condition: remove this patch once a pinned upstream Grok Build release
  uses platform-neutral protoc dependency output.

The canonical patch file and its SHA-256 are recorded in
`sidecar.lock.json`. Changing either requires release review and a fresh native
build on every published architecture.
