#!/usr/bin/env bash
# Installs a Linux package in the Lima VM xorabuild (Ubuntu 24.04 arm64; an x64 package runs through Rosetta, with
# its amd64 libraries from the Ubuntu archive), runs the update drill and the UI smoke under Xvfb, removes the package,
# then checks that the AppImage boots (13 §2.1). Ubuntu 24.04 only lets programs with an AppArmor profile create user
# namespaces; the deb installs one for the app, so the drill checks the installed app with its sandbox.
#
#   build/vm/linux.sh arm64|x64 [package.deb]
#
# Before: node build/package.ts linux-x64 linux-arm64 && node build/vm/harness.ts. The first run creates the VM
# (4 CPUs, 6 GiB, 30 GiB disk; pabox's frxbuild is left alone) and puts Xvfb, git and Node 24 in it.
set -euo pipefail

ARCH=${1:?usage: build/vm/linux.sh arm64|x64 [package.deb]}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CACHE=$HOME/Library/Caches/xora-vm
VM=xorabuild
NODE=node-v24.22.2-linux-arm64
case $ARCH in
  arm64) DEB_ARCH=arm64; IMAGE_ARCH=arm64 ;;
  x64) DEB_ARCH=amd64; IMAGE_ARCH=x86_64 ;;
  *) echo "arch must be arm64 or x64" >&2; exit 2 ;;
esac
DEB=${2:-$(ls "$ROOT"/apps/desktop/release/*-linux-"$DEB_ARCH".deb | head -1)}
IMAGE=$(ls "$ROOT"/apps/desktop/release/*-linux-"$IMAGE_ARCH".AppImage | head -1)
OUT=$ROOT/dist/vm-out/linux-$ARCH
APP='/opt/Xora Code/xora-code'
lima() { limactl shell --workdir / "$VM" "$@"; }

[ -f "$ROOT/dist/vm-harness/drill.mjs" ] || { echo "run node build/vm/harness.ts first" >&2; exit 2; }
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$NODE.tar.xz" ]; then
  curl -fsSL -o "$CACHE/node-v24.22.2-SHASUMS256.txt" https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
  curl -fsSL -o "$CACHE/$NODE.tar.xz.part" "https://nodejs.org/dist/v24.22.2/$NODE.tar.xz"
  want=$(grep " $NODE.tar.xz\$" "$CACHE/node-v24.22.2-SHASUMS256.txt" | cut -d' ' -f1)
  [ "$(shasum -a 256 "$CACHE/$NODE.tar.xz.part" | cut -d' ' -f1)" = "$want" ] || { echo "node checksum mismatch" >&2; exit 1; }
  mv "$CACHE/$NODE.tar.xz.part" "$CACHE/$NODE.tar.xz"
fi
if ! limactl list -q | grep -qx "$VM"; then
  limactl create --tty=false --name="$VM" --vm-type=vz --rosetta --cpus=4 --memory=6 --disk=30 template:ubuntu-24.04
fi
[ "$(limactl list --format '{{.Status}}' "$VM")" = "Running" ] || limactl start "$VM"

echo "== prepare the VM"
lima sudo bash -s <<EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if [ ! -x /opt/node/bin/node ]; then
  mkdir -p /opt/node && tar -xJf '$CACHE/$NODE.tar.xz' -C /opt/node --strip-components=1
fi
if ! dpkg --print-foreign-architectures | grep -qx amd64; then
  # ports.ubuntu.com only has arm64; amd64 libraries for x64 packages come from the main archive.
  dpkg --add-architecture amd64
  printf '%s\n' 'Types: deb' 'URIs: http://archive.ubuntu.com/ubuntu' 'Suites: noble noble-updates noble-backports' \
    'Components: main universe restricted multiverse' 'Architectures: amd64' \
    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' '' 'Types: deb' 'URIs: http://security.ubuntu.com/ubuntu' \
    'Suites: noble-security' 'Components: main universe restricted multiverse' 'Architectures: amd64' \
    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' > /etc/apt/sources.list.d/ubuntu-amd64.sources
fi
# Lima gives the VM a new cloud-init instance id on every start, and cloud-init then rewrites ubuntu.sources.
grep -q '^Architectures: arm64' /etc/apt/sources.list.d/ubuntu.sources ||
  sed -i '/^URIs: http:\/\/ports.ubuntu.com/a Architectures: arm64' /etc/apt/sources.list.d/ubuntu.sources
apt-get update -qq
# CJK fonts: the smoke runs the UI in Chinese (--lang=zh-CN), and without them its screenshots show boxes.
dpkg -s xvfb xauth git fonts-noto-cjk >/dev/null 2>&1 || apt-get install -y -qq xvfb xauth git fonts-noto-cjk >/dev/null
EOF

echo "== install $(basename "$DEB")"
lima sudo bash -s <<EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
for installed in \$(dpkg-query -W -f='\${Package}:\${Architecture}\n' xora-code 2>/dev/null); do apt-get remove -y -qq "\$installed" >/dev/null; done
cp '$DEB' /tmp/xora-code.deb
apt-get install -y -qq /tmp/xora-code.deb 2>&1 | grep -v -e '^Selecting' -e '^Preparing' -e '^Unpacking' -e '^Setting up' -e '^Processing' -e '^(Reading' || true
rm /tmp/xora-code.deb
echo "installed: \$(dpkg-query -W -f='\${Package}:\${Architecture} \${Version}' xora-code), \$(du -sh '/opt/Xora Code' | cut -f1)"
echo "app: \$(file -b '$APP' | cut -d, -f1-2)"
echo "chrome-sandbox: \$(stat -c '%A %U' '/opt/Xora Code/chrome-sandbox'), apparmor: \$(aa-status 2>/dev/null | grep -c xora-code) profile(s)"
EOF

echo "== drill and smoke under Xvfb"
lima bash -s <<EOF
export PATH=/opt/node/bin:\$PATH
rm -rf /tmp/xora-out && mkdir -p /tmp/xora-out/shots && cd /tmp
xvfb-run -a -s '-screen 0 1440x900x24' node '$ROOT/dist/vm-harness/drill.mjs' --app '$APP' --bundles '$ROOT/dist/vm-harness/bundles' > /tmp/xora-out/drill.log 2>&1
echo exit=\$? >> /tmp/xora-out/drill.log
xvfb-run -a -s '-screen 0 1440x900x24' node '$ROOT/dist/vm-harness/ui-smoke.mjs' --app '$APP' --shots /tmp/xora-out/shots > /tmp/xora-out/smoke.log 2>&1
echo exit=\$? >> /tmp/xora-out/smoke.log
EOF

rm -rf "$OUT" && mkdir -p "$OUT"
lima tar -C /tmp/xora-out -cf - . | tar -xf - -C "$OUT"

echo "== remove"
lima sudo bash -s <<'EOF' | tee "$OUT/uninstall.txt"
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y -qq "$(dpkg-query -W -f='${Package}:${Architecture}' xora-code)" >/dev/null 2>&1
left=0
for path in '/opt/Xora Code' /usr/bin/xora-code /usr/share/applications/xora-code.desktop /etc/apparmor.d/xora-code; do
  if [ -e "$path" ] || [ -L "$path" ]; then echo "left: $path"; left=$((left + 1)); fi
done
echo "removed: $left paths left"
EOF

echo "== AppImage $(basename "$IMAGE")"
lima sudo bash -s <<'EOF'
# Rosetta's binfmt rule wants zeros where an AppImage keeps its magic (ELF bytes 8-10); an x64 host runs it directly.
# Lost on reboot.
[ ! -e /proc/sys/fs/binfmt_misc/rosetta ] || [ -e /proc/sys/fs/binfmt_misc/rosetta-appimage ] ||
  echo ':rosetta-appimage:M:0:\x7fELF\x02\x01\x01\x00AI\x02\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/mnt/lima-rosetta/rosetta:OCF' >/proc/sys/fs/binfmt_misc/register
EOF
lima bash -s <<EOF | tee "$OUT/appimage.txt"
data=\$(mktemp -d)
cd /tmp
# The shell quits once the boot counts as good, as in the drill.
XORA_DATA_DIR=\$data XORA_TEST_HIDE_WINDOWS=1 XORA_TEST_EXIT_AFTER_GOOD=1 XORA_GOOD_AFTER_MS=1500 \\
  timeout 180 xvfb-run -a '$IMAGE' --password-store=basic > /tmp/xora-appimage.log 2>&1
code=\$?
# electron-builder's AppRun adds --no-sandbox where user namespaces are restricted (Ubuntu 24.04: no profile for it).
sandbox=\$(unshare -Ur true 2>/dev/null && echo on || echo 'off, AppRun adds --no-sandbox')
echo "appimage: exit \$code, \$(grep -c ' is good' /tmp/xora-appimage.log) good boot, sandbox \$sandbox"
rm -rf "\$data"
EOF

echo "== results in ${OUT#"$ROOT"/}"
tail -n 15 "$OUT/drill.log" "$OUT/smoke.log"
grep -q '^exit=0' "$OUT/drill.log" && grep -q '^exit=0' "$OUT/smoke.log" && grep -q '^removed: 0 paths left' "$OUT/uninstall.txt" &&
  grep -q '^appimage: exit 0, 1 good boot' "$OUT/appimage.txt"
