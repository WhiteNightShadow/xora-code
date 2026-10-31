#!/usr/bin/env bash
# Installs a Windows package in one of the local test VMs, runs the update drill and the UI smoke in the signed-in
# desktop session, then uninstalls it (13 §2.1). The VMs are pabox's (~/VMs/pabox-win-test*, started with its
# scripts/win-test-vm/run-vm.sh): this script only uses C:\xora and the scheduled task XoraSmoke, and stops when
# the VM is busy. Desktop windows only work in the signed-in session; over ssh (session 0) they crash.
#
#   build/vm/windows.sh <vm> [installer.exe]
#     vm: arm64  the Windows 11 arm64 VM (HVF, fast; runs the x64 package through Prism too)
#         x64    the Windows 11 x64 VM (TCG, several times slower)
#
# Before: node build/package.ts win-x64 win-arm64 && node build/vm/harness.ts; the official Node and MinGit zips in
# ~/Library/Caches/xora-vm (SHA-256 checked against nodejs.org and the git-for-windows release notes).
set -euo pipefail

VM=${1:?usage: build/vm/windows.sh arm64|x64 [installer.exe]}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CACHE=$HOME/Library/Caches/xora-vm
case $VM in
  arm64) PORT=2222; GIT=MinGit-2.56.0.4-arm64.zip; MINUTES=30; SCALE=1 ;;
  x64)   PORT=2223; GIT=MinGit-2.56.0.4-64-bit.zip; MINUTES=150; SCALE=6 ;;
  *) echo "vm must be arm64 or x64" >&2; exit 2 ;;
esac
NODE=node-v24.22.2-win-$VM
INSTALLER=${2:-$(ls "$ROOT"/apps/desktop/release/*-win-"$VM".exe | head -1)}
OUT=$ROOT/dist/vm-out/windows-$VM-$(basename "$INSTALLER" .exe | sed 's/.*-win-//')
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15)
vm() { ssh "${SSH_OPTS[@]}" -p "$PORT" pabox@127.0.0.1 "$@"; }
put() { scp "${SSH_OPTS[@]}" -P "$PORT" "$1" "pabox@127.0.0.1:$2" >/dev/null; }
get() { scp "${SSH_OPTS[@]}" -P "$PORT" -r "pabox@127.0.0.1:$1" "$2" >/dev/null; }

for file in "$CACHE/$NODE.zip" "$CACHE/$GIT" "$INSTALLER" "$ROOT/dist/vm-harness/drill.mjs"; do
  [ -f "$file" ] || { echo "missing $file" >&2; exit 2; }
done

busy=$(vm '$names = @(Get-ScheduledTask | Where-Object { $_.State -eq "Running" -and $_.TaskName -match "Smoke" } | ForEach-Object TaskName) + @(Get-Process -Name node, firefox, "Xora Code" -ErrorAction SilentlyContinue | ForEach-Object ProcessName); $names -join ","' | tr -d '\r')
if [ -n "$busy" ]; then
  echo "the VM is in use ($busy); try again when it is idle" >&2
  exit 1
fi

echo "== copy to the VM ($VM)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
COPYFILE_DISABLE=1 tar -C "$ROOT/dist" -czf "$tmp/harness.tgz" vm-harness
vm 'New-Item -ItemType Directory -Force C:\xora | Out-Null; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue C:\xora\harness, C:\xora\out, C:\xora\setup.exe; New-Item -ItemType Directory -Force C:\xora\out | Out-Null'
put "$tmp/harness.tgz" C:/xora/harness.tgz
put "$INSTALLER" C:/xora/setup.exe
if [ "$(vm "Test-Path C:\\xora\\node\\node.exe")" != "True" ]; then put "$CACHE/$NODE.zip" C:/xora/node.zip; fi
if [ "$(vm "Test-Path C:\\xora\\mingit\\cmd\\git.exe")" != "True" ]; then put "$CACHE/$GIT" C:/xora/mingit.zip; fi

cat > "$tmp/run.cmd" <<EOF
@echo off
rem Runs in the signed-in session (scheduled task XoraSmoke): the drill, then the UI smoke.
set PATH=C:\xora\node;C:\xora\mingit\cmd;%PATH%
set APP=%LOCALAPPDATA%\Programs\Xora Code\Xora Code.exe
cd /d C:\xora\harness
node drill.mjs --app "%APP%" --bundles C:\xora\harness\bundles --timeout-scale $SCALE > C:\xora\out\drill.log 2>&1
rem The redirection goes first: in "echo exit=0>> file" cmd takes the 0 for a handle number.
>> C:\xora\out\drill.log echo exit=%ERRORLEVEL%
node ui-smoke.mjs --app "%APP%" --shots C:\xora\out\shots --timeout-scale $SCALE > C:\xora\out\smoke.log 2>&1
>> C:\xora\out\smoke.log echo exit=%ERRORLEVEL%
EOF
put "$tmp/run.cmd" C:/xora/run.cmd

echo "== install"
vm "\$ErrorActionPreference = 'Stop'
Set-Location C:\\xora
if (Test-Path node.zip) { tar -xf node.zip; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue node; Rename-Item $NODE node; Remove-Item node.zip }
if (Test-Path mingit.zip) { New-Item -ItemType Directory -Force mingit | Out-Null; tar -xf mingit.zip -C mingit; Remove-Item mingit.zip }
tar -xzf harness.tgz; Rename-Item vm-harness harness; Remove-Item harness.tgz
New-Item -ItemType Directory -Force C:\\xora\\out\\shots | Out-Null
\$dir = Join-Path \$env:LOCALAPPDATA 'Programs\\Xora Code'
\$uninstaller = Join-Path \$dir 'Uninstall Xora Code.exe'
if (Test-Path \$uninstaller) { Start-Process -Wait \$uninstaller -ArgumentList '/S'; for (\$i = 0; \$i -lt 60 -and (Test-Path \$uninstaller); \$i++) { Start-Sleep 1 } }
\$started = Get-Date
Start-Process -Wait C:\\xora\\setup.exe -ArgumentList '/S'
\$app = Join-Path \$dir 'Xora Code.exe'
if (-not (Test-Path \$app)) { throw \"not installed: \$app\" }
\$files = Get-ChildItem -Recurse -File \$dir
'installed in {0:n0}s: {1} files, {2:n0} MB, {3}' -f ((Get-Date) - \$started).TotalSeconds, \$files.Count, ((\$files | Measure-Object Length -Sum).Sum / 1MB), \$dir
'machine: ' + \$env:PROCESSOR_ARCHITECTURE + ', app: ' + [System.Diagnostics.FileVersionInfo]::GetVersionInfo(\$app).FileVersion
(& C:\\xora\\node\\node.exe -p \"process.arch + ' node ' + process.version\") + ', ' + (& C:\\xora\\mingit\\cmd\\git.exe --version)"

echo "== drill and smoke in the desktop session (up to $MINUTES minutes)"
vm "\$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c C:\\xora\\run.cmd' -WorkingDirectory 'C:\\xora'
\$principal = New-ScheduledTaskPrincipal -UserId \"\$env:COMPUTERNAME\\pabox\" -LogonType Interactive -RunLevel Limited
\$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $MINUTES) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName XoraSmoke -Action \$action -Principal \$principal -Settings \$settings -Force | Out-Null
Start-ScheduledTask -TaskName XoraSmoke"
for ((i = 0; i < MINUTES * 6; i++)); do
  sleep 10
  state=$(vm '(Get-ScheduledTask -TaskName XoraSmoke).State' | tr -d '\r')
  [ "$state" = "Running" ] || break
done
vm 'Unregister-ScheduledTask -TaskName XoraSmoke -Confirm:$false' || true

echo "== uninstall"
vm "\$dir = Join-Path \$env:LOCALAPPDATA 'Programs\\Xora Code'
\$uninstaller = Join-Path \$dir 'Uninstall Xora Code.exe'
Start-Process -Wait \$uninstaller -ArgumentList '/S'
for (\$i = 0; \$i -lt 60 -and (Test-Path \$uninstaller); \$i++) { Start-Sleep 1 }
\$left = @(Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue \$dir)
\$shortcuts = @(Get-ChildItem -ErrorAction SilentlyContinue \"\$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Xora Code*\", \"\$env:USERPROFILE\\Desktop\\Xora Code*\")
\$key = Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | Where-Object { (Get-ItemProperty \$_.PSPath).DisplayName -like 'Xora Code*' }
'uninstalled: {0} files left, {1} shortcuts left, uninstall entry {2}' -f \$left.Count, \$shortcuts.Count, \$(if (\$key) { 'left' } else { 'removed' })" | tee "$tmp/uninstall.txt"

rm -rf "$OUT" && mkdir -p "$OUT"
get C:/xora/out/. "$OUT"
cp "$tmp/uninstall.txt" "$OUT/"
# Leave only Node and MinGit (reused next time) in pabox's VM.
vm 'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue C:\xora\setup.exe, C:\xora\harness, C:\xora\out, C:\xora\run.cmd'
echo "== results in ${OUT#"$ROOT"/}"
tail -n 15 "$OUT/drill.log" "$OUT/smoke.log" 2>/dev/null || true
grep -q '^exit=0' "$OUT/drill.log" && grep -q '^exit=0' "$OUT/smoke.log" && grep -q '0 files left, 0 shortcuts left, uninstall entry removed' "$OUT/uninstall.txt"
