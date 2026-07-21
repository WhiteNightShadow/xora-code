# ripgrep source-build notice

Xora Code bundles ripgrep 15.0.0 in the Grok Build sidecar and uses the same
native executable for project search. The bundled `rg`/`rg.exe` is built from
the unmodified `ripgrep` 15.0.0 crate published on crates.io, rather than copied
from a prebuilt release or npm platform archive.

The release build uses `cargo install --locked --features pcre2` with Rust
1.92.0 on each native target. Xora Code supplies that verified native binary to
Grok Build through both `GROK_SHELL_BUNDLE_RG_PATH` and
`GROK_TOOLS_BUNDLE_RG_PATH`, and the native application packaging hook replaces
Theia's prebuilt project-search copy before signing. These steps replace only
binary acquisition and do not modify Grok Build or ripgrep source code.

ripgrep remains dual-licensed under the MIT License or the Unlicense, at the
user's option. Its complete license attribution is reproduced in the pinned
Grok Build tool notice shipped alongside this file as
`GROK-TOOLS-THIRD-PARTY-NOTICES.md`.
