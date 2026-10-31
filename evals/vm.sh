#!/usr/bin/env bash
# Runs the real-model evaluation in the Lima VM xorabuild (see build/vm/linux.sh): the agents run the commands they
# write, so they get a throwaway Ubuntu instead of this machine. Results land in dist/eval-out/<time>/.
#
#   XORA_EVAL_KEY_FILE=<file with the DeepSeek API key> evals/vm.sh [--tasks a,b] [--model deepseek-v4-pro]
#
# Before: node evals/build.ts. The key goes to the VM on stdin, into the environment of the runner only: it is not on a
# command line, and nothing stores it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VM=xorabuild
KEY_FILE=${XORA_EVAL_KEY_FILE:?set XORA_EVAL_KEY_FILE to a file holding the API key}
[ -f "$ROOT/dist/eval/run.mjs" ] || { echo "run node evals/build.ts first" >&2; exit 2; }
limactl list -q | grep -qx "$VM" || { echo "create the VM first: build/vm/linux.sh arm64" >&2; exit 2; }
[ "$(limactl list --format '{{.Status}}' "$VM")" = "Running" ] || limactl start "$VM" >/dev/null 2>&1

OUT=$ROOT/dist/eval-out/$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
# python3 and git for the tasks' checks; Node 24 is in /opt/node (build/vm/linux.sh).
limactl shell --workdir / "$VM" bash -c 'command -v python3 >/dev/null && command -v git >/dev/null && [ -x /opt/node/bin/node ]' ||
  { echo "the VM lacks python3, git or /opt/node: run build/vm/linux.sh arm64 once" >&2; exit 2; }

status=0
limactl shell --workdir / "$VM" bash -c "IFS= read -r XORA_EVAL_DEEPSEEK_KEY || true; export XORA_EVAL_DEEPSEEK_KEY
  export PATH=/opt/node/bin:/usr/bin:/bin
  rm -rf /tmp/xora-eval && cd /tmp
  node '$ROOT/dist/eval/run.mjs' --engine '$ROOT/dist/eval/engine.cjs' --tasks-dir '$ROOT/dist/eval/tasks' --out /tmp/xora-eval $*" <"$KEY_FILE" ||
  status=$?
limactl shell --workdir / "$VM" tar -C /tmp/xora-eval -cf - . | tar -xf - -C "$OUT"
echo "results in ${OUT#"$ROOT"/}"
exit $status
