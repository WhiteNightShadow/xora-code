# Copyright (c) 2026 Xora Code contributors.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceArchive,
    [Parameter(Mandatory = $true)][string]$SourceSha256,
    [Parameter(Mandatory = $true)][string]$PluginArchive,
    [Parameter(Mandatory = $true)][string]$PluginSha256,
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$WorkRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$ToolCache = (Join-Path $env:LOCALAPPDATA 'XoraCode\native-preview-tools'),
    [string]$ToolLock
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Windows PowerShell 5.1 evaluates parameter default expressions before it
# initializes $PSScriptRoot. Resolve the sibling lock only after binding so a
# normal `-File native-preview-windows-x64.ps1 ...` invocation works there.
if ([string]::IsNullOrWhiteSpace($ToolLock)) {
    $ToolLock = Join-Path $PSScriptRoot 'native-preview-tools.lock.json'
}

function Fail {
    param([Parameter(Mandatory = $true)][string]$Message)
    throw "Xora Code Windows native preview build refused: $Message"
}

function Assert-AbsoluteNonRootPath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not [IO.Path]::IsPathRooted($Value)) {
        Fail "$Label must be an absolute non-root path"
    }
    $full = [IO.Path]::GetFullPath($Value)
    $root = [IO.Path]::GetPathRoot($full)
    if (-not $root -or $full.TrimEnd('\') -eq $root.TrimEnd('\')) {
        Fail "$Label must be an absolute non-root path"
    }
    return $full
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory = $WorkRoot
    )
    Push-Location -LiteralPath $WorkingDirectory
    try {
        Write-Output "> $File $($Arguments -join ' ')"
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            Fail "$File exited with status $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Invoke-CheckedWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory = $WorkRoot,
        [ValidateRange(1, 10)][int]$Attempts = 3,
        [ValidateRange(0, 300)][int]$DelaySeconds = 10
    )
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Invoke-Checked -File $File -Arguments $Arguments -WorkingDirectory $WorkingDirectory
            return
        } catch {
            if ($attempt -ge $Attempts) {
                throw
            }
            Write-Warning "Command failed (attempt $attempt/$Attempts); retrying in $DelaySeconds seconds: $File"
            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

function Assert-Version {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Pattern
    )
    $value = (& $File @Arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $value -notmatch $Pattern) {
        Fail "unexpected $File version: $value"
    }
    Write-Host "$File version verified: $(($value -split "`r?`n")[0])"
    return $value
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$ExpectedHash,
        [Parameter(Mandatory = $true)][long]$ExpectedSize,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) {
        $item = Get-Item -LiteralPath $Destination
        if (-not $item.PSIsContainer -and $item.Length -eq $ExpectedSize -and
            (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant() -eq $ExpectedHash) {
            return
        }
        Fail "cached tool has the wrong size or SHA-256: $Destination"
    }
    $temporary = "$Destination.part-$PID"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    try {
        Invoke-Checked -File 'curl.exe' -Arguments @(
            '--fail', '--location', '--retry', '4', '--retry-delay', '3', '--connect-timeout', '20',
            '--output', $temporary, $Url
        )
        $item = Get-Item -LiteralPath $temporary
        if ($item.Length -ne $ExpectedSize) {
            Fail "downloaded tool has the wrong size: $Url"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
        if ($actual -ne $ExpectedHash) {
            Fail "downloaded tool has the wrong SHA-256: $Url"
        }
        Move-Item -LiteralPath $temporary -Destination $Destination
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    Fail 'this script requires native Windows x64'
}
if (-not (Test-Path -LiteralPath $SourceArchive -PathType Leaf)) {
    Fail 'source archive is missing'
}
if (((Get-Item -LiteralPath $SourceArchive).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail 'source archive must not be a symbolic link'
}
if ($SourceSha256 -cnotmatch '^[0-9a-f]{64}$') {
    Fail '-SourceSha256 must be lowercase SHA-256'
}
if (-not (Test-Path -LiteralPath $PluginArchive -PathType Leaf)) {
    Fail 'plugin archive is missing'
}
if (((Get-Item -LiteralPath $PluginArchive).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail 'plugin archive must not be a symbolic link or reparse point'
}
if ($PluginSha256 -cnotmatch '^[0-9a-f]{64}$') {
    Fail '-PluginSha256 must be lowercase SHA-256'
}
if ($Commit -cnotmatch '^[0-9a-f]{40}$') {
    Fail '-Commit must be a full lowercase Git SHA'
}

$SourceArchive = [IO.Path]::GetFullPath($SourceArchive)
$PluginArchive = [IO.Path]::GetFullPath($PluginArchive)
$WorkRoot = Assert-AbsoluteNonRootPath -Value $WorkRoot -Label '-WorkRoot'
$OutputDirectory = Assert-AbsoluteNonRootPath -Value $OutputDirectory -Label '-OutputDirectory'
$ToolCache = Assert-AbsoluteNonRootPath -Value $ToolCache -Label '-ToolCache'
$ToolLock = [IO.Path]::GetFullPath($ToolLock)
if ($WorkRoot.Length -gt 80) {
    Fail '-WorkRoot must remain short (80 characters or fewer) for native Windows dependencies'
}
if (Test-Path -LiteralPath $WorkRoot) {
    Fail "work root already exists: $WorkRoot"
}
if (-not (Test-Path -LiteralPath $ToolLock -PathType Leaf) -or
    (((Get-Item -LiteralPath $ToolLock).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail 'native tool lock is missing or is a symbolic link'
}

# Remove ambient language/runtime hooks that can execute code in Node, Python,
# or rustc, or silently redirect a native build. Proxy settings and the
# caller's Rustup home remain available; Cargo receives an isolated home.
foreach ($ambientOverride in @(
    'NODE_OPTIONS', 'NODE_PATH', 'COREPACK_HOME', 'COREPACK_INTEGRITY_KEYS',
    'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP',
    'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS',
    'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CARGO_ENCODED_RUSTFLAGS',
    'CARGO_HOME', 'CARGO_NET_OFFLINE', 'CARGO_NET_RETRY', 'CARGO_NET_GIT_FETCH_WITH_CLI',
    'CARGO_HTTP_TIMEOUT', 'CARGO_REGISTRIES_CRATES_IO_INDEX',
    'CARGO_REGISTRIES_CRATES_IO_PROTOCOL', 'CARGO_SOURCE_CRATES_IO_REPLACE_WITH'
)) {
    Remove-Item -LiteralPath "Env:$ambientOverride" -Force -ErrorAction SilentlyContinue
}

foreach ($command in @('curl.exe', 'git.exe', 'tar.exe', 'python.exe', 'rustup.exe', 'cargo.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        Fail "required host command is missing: $command"
    }
}

$lock = Get-Content -LiteralPath $ToolLock -Raw | ConvertFrom-Json
if ($lock.schemaVersion -ne 1) {
    Fail 'invalid native tool lock schema'
}
$node = $lock.node
$nodeTarget = $node.targets.'win32-x64'
$protoc = $lock.protoc
$protocTarget = $protoc.targets.'win32-x64'
$NodeVersion = [string]$node.version
$NodeUrl = [string]$nodeTarget.url
$NodeSha256 = [string]$nodeTarget.sha256
$NodeSize = [long]$nodeTarget.size
$NodeArchiveName = [string]$nodeTarget.archive
$NodeDirectoryName = [string]$nodeTarget.directory
$YarnVersion = [string]$lock.yarn
$RustVersion = [string]$lock.rust
$DotSlashVersion = [string]$lock.dotslash
$ProtocVersion = [string]$protoc.version
$ProtocUrl = [string]$protocTarget.url
$ProtocSha256 = [string]$protocTarget.sha256
$ProtocSize = [long]$protocTarget.size
$ProtocArchiveName = [string]$protocTarget.archive

if ($NodeVersion -notmatch '^24\.\d+\.\d+$' -or
    $NodeUrl -ne "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName" -or
    $NodeArchiveName -ne "node-v$NodeVersion-win-x64.zip" -or
    $NodeDirectoryName -ne "node-v$NodeVersion-win-x64" -or
    $NodeSha256 -cnotmatch '^[0-9a-f]{64}$' -or $NodeSize -le 0) {
    Fail 'invalid or untrusted Node lock'
}
if ($YarnVersion -ne '1.22.22' -or $RustVersion -ne '1.92.0' -or $DotSlashVersion -ne '0.5.7') {
    Fail 'unexpected Yarn, Rust, or DotSlash lock'
}
if ($ProtocVersion -ne '29.3' -or
    $ProtocUrl -ne "https://github.com/protocolbuffers/protobuf/releases/download/v$ProtocVersion/$ProtocArchiveName" -or
    $ProtocArchiveName -ne "protoc-$ProtocVersion-win64.zip" -or
    $ProtocSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ProtocSize -le 0) {
    Fail 'invalid or untrusted protoc lock'
}

New-Item -ItemType Directory -Path $WorkRoot, $OutputDirectory, $ToolCache -Force | Out-Null
$SourceDirectory = Join-Path $WorkRoot 'source'
$GrokWork = Join-Path $WorkRoot 'grok'
$WorkTools = Join-Path $WorkRoot 'tools'
$LogFile = Join-Path $WorkRoot 'build.log'
New-Item -ItemType Directory -Path $SourceDirectory, $WorkTools -Force | Out-Null
Start-Transcript -Path $LogFile -Force | Out-Null

try {
    Write-Output "Building Xora Code Windows x64 preview for commit $Commit"
    $actualSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceArchive).Hash.ToLowerInvariant()
    if ($actualSourceHash -ne $SourceSha256) {
        Fail 'source archive SHA-256 mismatch'
    }
    $archiveCommitScript = @'
import sys, tarfile
archive = tarfile.open(sys.argv[1], "r:gz")
print(archive.pax_headers.get("comment", ""))
archive.close()
'@
    # Passing multiline Python through `python -c` loses nested quotes under
    # Windows PowerShell 5.1's native argv conversion. Use a UTF-8 temporary
    # source file inside the new work root, then remove it immediately.
    $archiveCommitVerifier = Join-Path $WorkRoot 'verify-archive-commit.py'
    $archiveCommitEncoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($archiveCommitVerifier, "$archiveCommitScript`n", $archiveCommitEncoding)
    try {
        $archiveCommit = (& python.exe $archiveCommitVerifier $SourceArchive 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $archiveCommit -ne $Commit) {
            Fail 'Git archive commit identity does not match -Commit'
        }
    } finally {
        Remove-Item -LiteralPath $archiveCommitVerifier -Force -ErrorAction SilentlyContinue
    }

    $archiveEntries = @(& tar.exe -tzf $SourceArchive)
    if ($LASTEXITCODE -ne 0 -or $archiveEntries.Count -eq 0) {
        Fail 'source archive is empty or invalid'
    }
    $archiveListing = @(& tar.exe -tvzf $SourceArchive)
    if ($LASTEXITCODE -ne 0 -or $archiveListing.Count -eq 0) {
        Fail 'source archive listing failed'
    }
    foreach ($listing in $archiveListing) {
        if (-not ($listing.StartsWith('-') -or $listing.StartsWith('d'))) {
            Fail 'source archive contains a link or special file'
        }
    }
    $expectedPrefix = "xora-code-$Commit/"
    foreach ($entry in $archiveEntries) {
        if ($entry.StartsWith('/') -or $entry.Contains('\') -or
            ($entry -ne $expectedPrefix -and -not $entry.StartsWith($expectedPrefix, [StringComparison]::Ordinal))) {
            Fail "source archive contains an unsafe or mismatched path: $entry"
        }
        $remainder = $entry.Substring($expectedPrefix.Length)
        if ((($remainder -split '/') -contains '..') -or $remainder.StartsWith('/') -or $remainder.Contains('//')) {
            Fail "source archive contains path traversal: $entry"
        }
    }
    Invoke-Checked -File 'tar.exe' -Arguments @(
        '-xzf', $SourceArchive, '-C', $SourceDirectory, '--strip-components=1'
    )
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory 'package.json') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $SourceDirectory 'yarn.lock') -PathType Leaf)) {
        Fail 'extracted source is not an Xora Code repository'
    }
    if ((Test-Path -LiteralPath (Join-Path $SourceDirectory '.git')) -or
        (Test-Path -LiteralPath (Join-Path $SourceDirectory 'node_modules'))) {
        Fail 'source archive contains forbidden repository state'
    }
    $CommittedToolLock = Join-Path $SourceDirectory 'build\release\native-preview-tools.lock.json'
    $CommittedBuilder = Join-Path $SourceDirectory 'build\release\native-preview-windows-x64.ps1'
    if (-not (Test-Path -LiteralPath $CommittedToolLock -PathType Leaf)) {
        Fail 'committed native tool lock is missing'
    }
    $ExternalToolLockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ToolLock).Hash
    $CommittedToolLockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CommittedToolLock).Hash
    if ($ExternalToolLockHash -ne $CommittedToolLockHash) {
        Fail 'external tool lock differs from the committed source'
    }
    if (-not (Test-Path -LiteralPath $CommittedBuilder -PathType Leaf)) {
        Fail 'committed Windows builder is missing'
    }
    $RunningBuilderHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
    $CommittedBuilderHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CommittedBuilder).Hash
    if ($RunningBuilderHash -ne $CommittedBuilderHash) {
        Fail 'running Windows builder differs from the committed source'
    }
    $PluginExtractor = Join-Path $SourceDirectory 'build\release\extract-plugin-seed.py'
    if (-not (Test-Path -LiteralPath $PluginExtractor -PathType Leaf) -or
        (((Get-Item -LiteralPath $PluginExtractor).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail 'committed plugin seed extractor is missing or is a symbolic link'
    }
    $PluginDirectory = Join-Path $SourceDirectory 'plugins'
    New-Item -ItemType Directory -Path $PluginDirectory -Force | Out-Null
    Invoke-Checked -File 'python.exe' -Arguments @(
        $PluginExtractor, '--archive', $PluginArchive,
        '--sha256', $PluginSha256, '--destination', $PluginDirectory
    )

    $NodeArchive = Join-Path $ToolCache $NodeArchiveName
    $NodeDirectory = Join-Path $WorkTools $NodeDirectoryName
    Get-VerifiedDownload -Url $NodeUrl -ExpectedHash $NodeSha256 -ExpectedSize $NodeSize -Destination $NodeArchive
    Expand-Archive -LiteralPath $NodeArchive -DestinationPath $WorkTools
    $NodeExecutable = Join-Path $NodeDirectory 'node.exe'
    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        Fail 'verified Node archive did not produce node.exe'
    }

    $RustupExecutable = (Get-Command rustup.exe).Source
    $RustBinDirectory = Split-Path -Parent $RustupExecutable
    $env:Path = "$NodeDirectory;$RustBinDirectory;$env:Path"
    if ((& $NodeExecutable --version) -ne "v$NodeVersion") {
        Fail 'wrong Node version'
    }
    Invoke-Checked -File (Join-Path $NodeDirectory 'corepack.cmd') -Arguments @(
        'enable', '--install-directory', $NodeDirectory
    )
    Invoke-Checked -File (Join-Path $NodeDirectory 'corepack.cmd') -Arguments @(
        'prepare', "yarn@$YarnVersion", '--activate'
    )
    $YarnExecutable = Join-Path $NodeDirectory 'yarn.cmd'
    if ((& $YarnExecutable --version) -ne $YarnVersion) {
        Fail 'wrong Yarn version'
    }

    $env:RUSTUP_TOOLCHAIN = "$RustVersion-x86_64-pc-windows-msvc"
    $env:RUSTUP_USE_CURL = '1'
    $env:RUSTUP_MAX_RETRIES = '6'
    Invoke-Checked -File $RustupExecutable -Arguments @(
        'toolchain', 'install', $env:RUSTUP_TOOLCHAIN, '--profile', 'minimal'
    )
    $RustVersionOutput = Assert-Version -File 'rustc.exe' -Arguments @('--version') -Pattern "^rustc $([regex]::Escape($RustVersion))\b"
    $RustVerbose = (& rustc.exe -vV 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $RustVerbose -notmatch '(?m)^host:\s*x86_64-pc-windows-msvc\s*$') {
        Fail 'Rust host is not native Windows x64 MSVC'
    }

    # cargo install must link a native MSVC executable. Activate the compiler
    # and Windows SDK before building DotSlash rather than relying on the
    # caller to have opened a Developer PowerShell prompt.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        Fail 'Visual Studio Installer vswhere.exe is missing'
    }
    $vsInstall = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if (-not $vsInstall) {
        Fail 'Visual Studio 2022 C++ Build Tools are missing'
    }
    Import-Module (Join-Path $vsInstall 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $vsInstall -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
    $env:Path = "$NodeDirectory;$RustBinDirectory;$env:Path"
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -or
        -not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
        Fail 'MSVC x64 compiler and linker were not activated'
    }

    # Rustup continues to use its existing RUSTUP_HOME and standard proxy
    # variables. Cargo itself is isolated from the user profile and may only
    # resolve crates.io through Cargo's official sparse index.
    $CargoHome = Join-Path $ToolCache 'cargo-home'
    New-Item -ItemType Directory -Path $CargoHome -Force | Out-Null
    $CargoConfig = @'
[registries.crates-io]
index = "sparse+https://index.crates.io/"
protocol = "sparse"

[net]
retry = 6
git-fetch-with-cli = true

[http]
timeout = 120
'@
    $CargoConfigEncoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $CargoHome 'config.toml'), "$CargoConfig`n", $CargoConfigEncoding)
    $env:CARGO_HOME = $CargoHome

    $DotSlashRoot = Join-Path $WorkTools "dotslash-$DotSlashVersion-win32-x64"
    $DotSlashExecutable = Join-Path $DotSlashRoot 'bin\dotslash.exe'
    $DotSlashInstallArguments = @(
        'install', 'dotslash', '--locked', '--version', $DotSlashVersion, '--root', $DotSlashRoot
    )
    try {
        Invoke-Checked -File 'cargo.exe' -Arguments (@($DotSlashInstallArguments) + '--offline')
    } catch {
        Write-Warning 'Verified Cargo cache is incomplete; retrying DotSlash installation through the locked official registry.'
        Invoke-CheckedWithRetry -File 'cargo.exe' -Arguments $DotSlashInstallArguments -Attempts 3 -DelaySeconds 10
    }
    $env:Path = "$(Join-Path $DotSlashRoot 'bin');$env:Path"
    $DotSlashVersionOutput = Assert-Version -File $DotSlashExecutable -Arguments @('--version') -Pattern "\b$([regex]::Escape($DotSlashVersion))\b"

    $ProtocArchive = Join-Path $ToolCache $ProtocArchiveName
    $ProtocRoot = Join-Path $WorkTools "protoc-$ProtocVersion-win32-x64"
    Get-VerifiedDownload -Url $ProtocUrl -ExpectedHash $ProtocSha256 -ExpectedSize $ProtocSize -Destination $ProtocArchive
    Expand-Archive -LiteralPath $ProtocArchive -DestinationPath $ProtocRoot
    $ProtocExecutable = Join-Path $ProtocRoot 'bin\protoc.exe'
    if (-not (Test-Path -LiteralPath $ProtocExecutable -PathType Leaf)) {
        Fail 'verified protoc archive did not produce protoc.exe'
    }
    $env:Path = "$(Join-Path $ProtocRoot 'bin');$env:Path"
    $ProtocVersionOutput = Assert-Version -File $ProtocExecutable -Arguments @('--version') -Pattern "^libprotoc $([regex]::Escape($ProtocVersion))$"

    $env:Path = "$NodeDirectory;$(Join-Path $DotSlashRoot 'bin');$(Join-Path $ProtocRoot 'bin');$RustBinDirectory;$env:Path"

    $env:GITHUB_SHA = $Commit
    $env:YARN_CACHE_FOLDER = Join-Path $ToolCache 'yarn-cache'
    $env:npm_config_cache = Join-Path $ToolCache 'npm-cache'
    $env:npm_config_python = (Get-Command python.exe).Source
    $env:npm_config_msvs_version = '2022'
    $env:ELECTRON_CACHE = Join-Path $ToolCache 'electron-cache'
    # Puppeteer is transitive build/test tooling; its browser payload is not
    # shipped or used by Xora Code. Ignore incomplete browser caches on images.
    $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:CARGO_INCREMENTAL = '0'
    $env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'core.longpaths'
    $env:GIT_CONFIG_VALUE_0 = 'true'
    $env:PROTOC = $ProtocExecutable

    Invoke-CheckedWithRetry -File $YarnExecutable -Arguments @(
        'install', '--frozen-lockfile', '--non-interactive'
    ) -WorkingDirectory $SourceDirectory -Attempts 3 -DelaySeconds 10
    Invoke-Checked -File $NodeExecutable -Arguments @(
        'build/grok/build-sidecar.mjs', '--work-dir', $GrokWork,
        '--target', 'win32-x64', '--stage-dir', 'resources/sidecars/grok'
    ) -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $NodeExecutable -Arguments @(
        'build/grok/smoke-sidecar.mjs', '--binary', 'resources/sidecars/grok/grok.exe'
    ) -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $NodeExecutable -Arguments @(
        'build/grok/release-metadata.mjs', '--verify', '--stage-dir', 'resources/sidecars/grok', '--target', 'win32-x64'
    ) -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $YarnExecutable -Arguments @('build') -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $YarnExecutable -Arguments @('test') -WorkingDirectory $SourceDirectory
    $GrokTests = @(Get-ChildItem -LiteralPath (Join-Path $SourceDirectory 'build\grok\test') -File |
        Where-Object { $_.Name -match '\.test\.(?:mjs|ts)$' } |
        Sort-Object Name |
        Select-Object -ExpandProperty FullName)
    if ($GrokTests.Count -eq 0) {
        Fail 'Grok release safety tests are missing'
    }
    Invoke-Checked -File $NodeExecutable -Arguments (@('--test') + $GrokTests) -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $YarnExecutable -Arguments @(
        'workspace', '@xora-code/electron-app', 'verify:sidecar:preview'
    ) -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $YarnExecutable -Arguments @(
        'workspace', '@xora-code/electron-app', 'package:preview:installers', '--platform', 'windows', '--arch', 'x64'
    ) -WorkingDirectory $SourceDirectory
    Invoke-Checked -File $YarnExecutable -Arguments @(
        'sbom:preview', '--', '--target', 'win32-x64',
        '--cache-dir', (Join-Path $ToolCache 'syft'),
        '--output-dir', 'applications/electron/dist/preview-assets',
        '--source-dir', 'applications/electron/dist/win-unpacked'
    ) -WorkingDirectory $SourceDirectory

    $AssetRoot = Join-Path $SourceDirectory 'applications\electron\dist\preview-assets'
    Invoke-Checked -File $NodeExecutable -Arguments @(
        'build/sbom/verify-preview-assets.mjs', '--target', 'win32-x64',
        '--commit', $Commit, '--assets-dir', $AssetRoot
    ) -WorkingDirectory $SourceDirectory

    $ShortCommit = $Commit.Substring(0, 12)
    $BundleName = "xora-preview-win32-x64-$ShortCommit.zip"
    $Bundle = Join-Path $OutputDirectory $BundleName
    $BundleHashFile = "$Bundle.sha256.txt"
    $BuildReport = Join-Path $OutputDirectory "xora-preview-win32-x64-$ShortCommit.build.json"
    foreach ($output in @($Bundle, $BundleHashFile, $BuildReport)) {
        if (Test-Path -LiteralPath $output) {
            Fail "output file already exists: $output"
        }
    }
    $Assets = @(Get-ChildItem -LiteralPath $AssetRoot -File | Sort-Object Name | Select-Object -ExpandProperty FullName)
    if ($Assets.Count -eq 0) {
        Fail 'native preview asset set is empty'
    }
    Compress-Archive -LiteralPath $Assets -DestinationPath $Bundle -CompressionLevel Optimal
    $BundleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Bundle).Hash.ToLowerInvariant()
    "$BundleHash  $BundleName" | Set-Content -LiteralPath $BundleHashFile -Encoding Ascii

    $NodeVersionOutput = (& $NodeExecutable --version 2>&1 | Out-String).Trim()
    $YarnVersionOutput = (& $YarnExecutable --version 2>&1 | Out-String).Trim()
    $SidecarVersionOutput = (& (Join-Path $SourceDirectory 'resources\sidecars\grok\grok.exe') --version 2>&1 | Out-String).Trim()
    $BuildReportJson = [ordered]@{
        schemaVersion = 1
        product = 'xora-code'
        commit = $Commit
        target = 'win32-x64'
        sourceArchiveSha256 = $SourceSha256
        pluginArchiveSha256 = $PluginSha256
        node = $NodeVersionOutput
        yarn = $YarnVersionOutput
        rust = $RustVersionOutput
        dotslash = $DotSlashVersionOutput
        protoc = $ProtocVersionOutput
        sidecar = $SidecarVersionOutput
        bundle = $BundleName
        bundleSha256 = $BundleHash
        builtAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($BuildReport, "$BuildReportJson`n", $Utf8NoBom)

    Write-Output "XORA_WINDOWS_BUNDLE=$Bundle"
    Write-Output "XORA_WINDOWS_BUNDLE_SHA256=$BundleHash"
    Write-Output "XORA_WINDOWS_REPORT=$BuildReport"
    Write-Output "XORA_WINDOWS_LOG=$LogFile"
} finally {
    Stop-Transcript | Out-Null
}
