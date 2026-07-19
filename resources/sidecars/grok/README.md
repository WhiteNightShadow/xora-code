# Grok Build sidecar staging directory

Release automation places the verified, platform-specific Grok Build executable in this directory before Electron packaging. `electron-builder` copies its contents to `resources/sidecars/grok` outside `app.asar`.

Expected staged names:

- macOS and Linux: `grok`
- Windows: `grok.exe`

Do not commit downloaded executables directly. The release job must verify the pinned version and SHA-256 checksum, preserve the executable bit on macOS/Linux, and complete platform signing before the outer application is signed.
