# WhiteNight Code

WhiteNight Code is an open-source, model-neutral desktop Agent IDE built on Eclipse Theia, Electron, and ACP, with first-class Grok Build integration.

It combines a project explorer, Monaco editor, Diff editor and terminal with a right-side Agent workspace for streaming chat, plans, tool calls, permission decisions, safe file reverts, sessions and model selection. The Electron main process—not the renderer—owns Grok Build, credentials, policy and update activation.

> WhiteNight Code is an independent community project. It is not affiliated with, sponsored by, or endorsed by xAI. “Grok” and “Grok Build” are used only to accurately describe interoperability with the separately licensed upstream project; all related trademarks belong to their respective owners.

## Toolchain

- Node.js 24
- Yarn Classic 1.22.22
- Eclipse Theia 1.73.1
- Electron 39.8.7
- Grok Build 0.2.102 (`98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce`, `SOURCE_REV=124d85bc5dc6e7805560215fcc6d5413944920e1`)
- Rust 1.92.0 for native sidecar builds
- DotSlash 0.5.7 for pinned upstream build tools
- protoc 29.3 as the Windows-native fallback

Use Corepack to activate the pinned Yarn release:

```sh
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install
```

## Development

Build all workspace packages in dependency order:

```sh
yarn build
```

Start the desktop application after building:

```sh
yarn start:electron
```

The browser target is a development shell; the supported product target is Electron:

```sh
yarn start:browser
```

Create an unpacked Electron preview (works without a staged Grok binary) or a native installer for the current operating system:

```sh
yarn package:electron:preview
yarn package:electron
```

Formal packaging is fail-closed: it requires the pinned, native `grok`/`grok.exe`, release metadata matching the current OS/architecture, Rust target, Cargo package and profile, exact SHA-256 and size, executable/platform signature checks, `grok --version`, an ACP `initialize` smoke test, upstream notices and a generated SBOM. Grok is always launched with:

```text
grok --no-auto-update --cwd <trusted-root> agent --no-leader stdio
```

Set `WHITENIGHT_GROK_BINARY` only in an unpackaged development build to test a locally built pinned sidecar.

## Agent security model

- Projects are restricted by default. Terminals, tasks, Grok Build, MCP, hooks and executable plugins remain disabled until the user confirms trust in a native Electron dialog.
- The renderer cannot spawn processes, read credentials or make the final permission decision. Persistent rules are scoped to project, tool/command/path or MCP server, sidecar version and expiry.
- Every prompt performs Save All first; a save failure prevents the task. ACP filesystem and terminal bridges are deliberately not advertised in v0.1.
- API keys use Electron `safeStorage`. Linux `basic_text`/unknown backends fall back to memory-only credentials.
- Custom Providers support OpenAI Responses, OpenAI Chat Completions and Anthropic Messages. Only the selected Provider and current workspace MCP credentials are injected into a sidecar.
- Session events are redacted JSONL. Crashed prompts are never replayed automatically, and safe revert refuses to overwrite a concurrently edited file.

## Pinned Grok Build

The reproducible source contract is in [`build/grok/sidecar.lock.json`](build/grok/sidecar.lock.json). Native CI uses [`build/grok/build-sidecar.mjs`](build/grok/build-sidecar.mjs) to check out the full public commit, verify `SOURCE_REV`, Rust 1.92.0, DotSlash 0.5.7, the Windows protoc 29.3 fallback and the native target, then runs:

```sh
cargo build -p xai-grok-pager-bin --profile release-dist
```

The resulting `xai-grok-pager`/`.exe` is renamed to `grok`/`grok.exe` and kept outside ASAR. CI runs the real binary through `--version`, ACP `initialize`, API-key authentication and process-tree cleanup before packaging. Sidecar self-update is disabled; WhiteNight Code accepts only independently signed, monotonic component manifests compatible with the app and `homeCompatEpoch`.

## Release gate

The Release workflow builds on macOS arm64/x64, Windows x64, and Linux x64.
It intentionally fails before any build when Apple signing/notarization,
Windows code signing, Linux GPG, or either of the two independent Ed25519
update-manifest credentials is absent. Configure these repository secrets
before creating a formal `v*` release:

- `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, and
  `APPLE_TEAM_ID`
- `WINDOWS_CERTIFICATE_PFX_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`
- `LINUX_GPG_PRIVATE_KEY_BASE64` and `LINUX_GPG_PASSPHRASE`
- `APP_UPDATE_ED25519_PRIVATE_KEY_BASE64` and
  `SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64`

The Ed25519 values are base64-encoded PKCS#8 DER or PEM private keys and must
represent different key pairs. The release sequence is the monotonic GitHub
Actions run number. No development or preview workflow claims to produce
signed artifacts.

Before enabling a formal release, also commit the matching sidecar Ed25519
public key to `resources/update/sidecar-trusted-keys.json`. Its `keys` array is
intentionally empty in this v0.1 source baseline, so the Release workflow stays
fail-closed until the offline release key ceremony is complete.

The matching sidecar public key must also be committed in
`resources/update/sidecar-trusted-keys.json` with key ID
`sidecar-release-2026`; a secret alone cannot alter the trust anchor during
CI. The Release gate remains intentionally blocked while that key list is
empty.

## Repository layout

```text
applications/
  browser/                  Browser development target
  electron/                 Desktop product and packaging configuration
packages/                   Protocol/runtime libraries
build/grok/                 Pinned upstream source/build contract
build/update/               Signed manifest and atomic activation library
theia-extensions/
  product/                  WhiteNight Code branding and welcome experience
  whitenight-agent/         Agent UI and Electron-owned Grok host
plugins/                    Downloaded or bundled VS Code extensions
resources/sidecars/grok/    Verified Grok Build binary staging directory
```

## Product identity

- Product name: `WhiteNight Code`
- Application ID: `io.github.whitenightshadow.whitenightcode`
- Configuration directory: `.whitenight-code`
- URL scheme: `whitenight-code`

Brand assets under `applications/electron/resources` are intentionally source-friendly placeholders. Replace the platform icon files before producing signed public releases.

The intended GitHub remote is `https://github.com/WhiteNightShadow/whitenight-code`.

## License

WhiteNight Code is licensed under the Apache License 2.0. Eclipse Theia, Electron, Grok Build, VS Code extensions, and other dependencies retain their own licenses; see [NOTICE](NOTICE.md), [third-party notices](THIRD-PARTY-NOTICES.md), and [`resources/legal`](resources/legal/README.md).
