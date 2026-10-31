#!/usr/bin/env bash
# Runs evals/ui-team.ts in the Lima VM xorabuild against the installed Linux app: installs the deb, watches one team
# run under Xvfb, copies the screenshots and the log to dist/eval-ui/<time>/, then removes the app again.
#
#   XORA_EVAL_KEY_FILE=<key file> evals/ui-vm.sh <task> [arm64|x64] [ui-team options]
#
# Before: node build/package.ts linux-arm64 (or linux-x64) and node evals/build.ts.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VM=xorabuild
TASK=${1:?usage: evals/ui-vm.sh <task> [arm64|x64]}
ARCH=${2:-arm64}
shift $(( $# > 1 ? 2 : 1 ))
KEY_FILE=${XORA_EVAL_KEY_FILE:?set XORA_EVAL_KEY_FILE to a file holding the API key}
case $ARCH in arm64) DEB_ARCH=arm64 ;; x64) DEB_ARCH=amd64 ;; *) echo "arch must be arm64 or x64" >&2; exit 2 ;; esac
DEB=$(ls "$ROOT"/apps/desktop/release/*-linux-"$DEB_ARCH".deb | head -1)
[ -f "$ROOT/dist/eval/ui-team.mjs" ] || { echo "run node evals/build.ts first" >&2; exit 2; }
[ "$(limactl list --format '{{.Status}}' "$VM")" = "Running" ] || limactl start "$VM" >/dev/null 2>&1
OUT=$ROOT/dist/eval-ui/$(date +%Y%m%d-%H%M%S)-$TASK
mkdir -p "$OUT"

limactl shell --workdir / "$VM" sudo bash -c "export DEBIAN_FRONTEND=noninteractive; cp '$DEB' /tmp/xora-code.deb && apt-get install -y -qq /tmp/xora-code.deb >/dev/null 2>&1; rm /tmp/xora-code.deb"
status=0
limactl shell --workdir / "$VM" bash -c "IFS= read -r XORA_EVAL_DEEPSEEK_KEY || true; export XORA_EVAL_DEEPSEEK_KEY
  export PATH=/opt/node/bin:/usr/bin:/bin
  rm -rf /tmp/xora-ui && cd /tmp
  xvfb-run -a -s '-screen 0 1440x900x24' node '$ROOT/dist/eval/ui-team.mjs' --app '/opt/Xora Code/xora-code' --task '$ROOT/dist/eval/tasks/$TASK' --out /tmp/xora-ui $*" <"$KEY_FILE" ||
  status=$?
limactl shell --workdir / "$VM" tar -C /tmp/xora-ui -cf - . | tar -xf - -C "$OUT"
limactl shell --workdir / "$VM" sudo bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get purge -y -qq \$(dpkg-query -W -f='\${Package}:\${Architecture}' xora-code) >/dev/null 2>&1" || true
echo "results in ${OUT#"$ROOT"/}"
exit $status
