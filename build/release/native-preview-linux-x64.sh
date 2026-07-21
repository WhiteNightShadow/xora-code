#!/usr/bin/env bash
# Copyright (c) 2026 Xora Code contributors.
# SPDX-License-Identifier: Apache-2.0

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
tool_lock="$script_dir/native-preview-tools.lock.json"
source_archive=""
source_sha256=""
commit=""
work_root=""
output_directory=""
tool_cache="${XORA_NATIVE_TOOL_CACHE:-$HOME/.cache/xora-code/native-preview-tools}"

usage() {
    cat <<'EOF'
Usage: native-preview-linux-x64.sh \
  --source-archive <xora-code-<full-sha>.tar.gz> \
  --source-sha256 <sha256> \
  --commit <40-character-lowercase-git-sha> \
  --work-root <new-empty-build-directory> \
  --output-dir <artifact-output-directory> \
  [--tool-cache <persistent-tool-cache>] \
  [--tool-lock <native-preview-tools.lock.json>]

The source archive must be made with:
  git archive --format=tar --prefix="xora-code-$COMMIT/" "$COMMIT" | gzip -n > "xora-code-$COMMIT.tar.gz"
EOF
}

fail() {
    printf 'Xora Code Linux native preview build refused: %s\n' "$*" >&2
    exit 1
}

assert_clean_absolute_path() {
    local value="$1" label="$2" padded
    [[ -n "$value" && "$value" == /* && "$value" != / && "$value" != //* ]] || \
        fail "$label must be an absolute non-root path"
    padded="/${value#/}/"
    [[ "$padded" != *"/../"* && "$padded" != *"/./"* && "$padded" != *"//"* ]] || \
        fail "$label must not contain dot segments or repeated separators"
}

while (($#)); do
    case "$1" in
        --source-archive) source_archive="${2:-}"; shift 2 ;;
        --source-sha256) source_sha256="${2:-}"; shift 2 ;;
        --commit) commit="${2:-}"; shift 2 ;;
        --work-root) work_root="${2:-}"; shift 2 ;;
        --output-dir) output_directory="${2:-}"; shift 2 ;;
        --tool-cache) tool_cache="${2:-}"; shift 2 ;;
        --tool-lock) tool_lock="${2:-}"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) fail "unknown argument $1" ;;
    esac
done

[[ $(uname -s) == Linux ]] || fail "this script must run on Linux"
[[ $(uname -m) == x86_64 ]] || fail "this script requires a native x86_64 host"
[[ -f "$source_archive" && ! -L "$source_archive" ]] || fail "source archive is missing or is a symbolic link"
[[ "$source_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "--source-sha256 must be lowercase SHA-256"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "--commit must be a full lowercase Git SHA"
assert_clean_absolute_path "$work_root" "--work-root"
assert_clean_absolute_path "$output_directory" "--output-dir"
assert_clean_absolute_path "$tool_cache" "--tool-cache"
[[ -f "$tool_lock" && ! -L "$tool_lock" ]] || fail "tool lock is missing or is a symbolic link"
[[ ! -e "$work_root" ]] || fail "work root already exists: $work_root"

# Refuse ambient language/runtime hooks that can execute code in Node, Python,
# or rustc, or silently redirect a native build. Network proxy variables and
# the caller's Rustup home remain available; Cargo receives an isolated home.
for ambient_override in \
    NODE_OPTIONS NODE_PATH COREPACK_HOME COREPACK_INTEGRITY_KEYS \
    PYTHONHOME PYTHONPATH PYTHONSTARTUP \
    RUSTC RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER RUSTFLAGS \
    CARGO_BUILD_RUSTC CARGO_BUILD_RUSTC_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER \
    CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET CARGO_ENCODED_RUSTFLAGS \
    CARGO_HOME CARGO_NET_OFFLINE CARGO_NET_RETRY CARGO_NET_GIT_FETCH_WITH_CLI \
    CARGO_HTTP_TIMEOUT CARGO_REGISTRIES_CRATES_IO_INDEX \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL CARGO_SOURCE_CRATES_IO_REPLACE_WITH; do
    unset "$ambient_override"
done
unset ambient_override

for command in bash cmp curl git gzip make python3 rustup cargo sha256sum tar unzip xz; do
    command -v "$command" >/dev/null 2>&1 || fail "required host command is missing: $command"
done
command -v cc >/dev/null 2>&1 || fail "a native C compiler is required"
command -v c++ >/dev/null 2>&1 || fail "a native C++ compiler is required"

mapfile -t locked_values < <(python3 - "$tool_lock" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    lock = json.load(handle)
if lock.get("schemaVersion") != 1:
    raise SystemExit("invalid native tool lock schema")
node = lock["node"]
node_target = node["targets"]["linux-x64"]
protoc = lock["protoc"]
protoc_target = protoc["targets"]["linux-x64"]
for value in (
    node["version"], node_target["url"], node_target["sha256"], node_target["size"],
    node_target["archive"], node_target["directory"], lock["yarn"], lock["rust"],
    lock["dotslash"], protoc["version"], protoc_target["url"], protoc_target["sha256"],
    protoc_target["size"], protoc_target["archive"],
):
    print(value)
PY
)
[[ ${#locked_values[@]} -eq 14 ]] || fail "native tool lock is incomplete"
node_version="${locked_values[0]}"
node_url="${locked_values[1]}"
node_sha256="${locked_values[2]}"
node_size="${locked_values[3]}"
node_archive_name="${locked_values[4]}"
node_directory_name="${locked_values[5]}"
yarn_version="${locked_values[6]}"
rust_version="${locked_values[7]}"
dotslash_version="${locked_values[8]}"
protoc_version="${locked_values[9]}"
protoc_url="${locked_values[10]}"
protoc_sha256="${locked_values[11]}"
protoc_size="${locked_values[12]}"
protoc_archive_name="${locked_values[13]}"

[[ "$node_version" =~ ^24\.[0-9]+\.[0-9]+$ ]] || fail "Node lock is not an exact 24.x version"
[[ "$node_url" == "https://nodejs.org/dist/v${node_version}/${node_archive_name}" ]] || fail "untrusted Node URL"
[[ "$node_archive_name" == "node-v${node_version}-linux-x64.tar.xz" ]] || fail "unexpected Node archive"
[[ "$node_directory_name" == "node-v${node_version}-linux-x64" ]] || fail "unexpected Node directory"
[[ "$node_sha256" =~ ^[0-9a-f]{64}$ && "$node_size" =~ ^[0-9]+$ ]] || fail "invalid Node integrity lock"
[[ "$yarn_version" == 1.22.22 && "$rust_version" == 1.92.0 && "$dotslash_version" == 0.5.7 ]] || fail "unexpected Yarn, Rust, or DotSlash lock"
[[ "$protoc_version" == 29.3 ]] || fail "unexpected protoc version lock"
[[ "$protoc_url" == "https://github.com/protocolbuffers/protobuf/releases/download/v${protoc_version}/${protoc_archive_name}" ]] || fail "untrusted protoc URL"
[[ "$protoc_archive_name" == "protoc-${protoc_version}-linux-x86_64.zip" ]] || fail "unexpected protoc archive"
[[ "$protoc_sha256" =~ ^[0-9a-f]{64}$ && "$protoc_size" =~ ^[0-9]+$ ]] || fail "invalid protoc integrity lock"

mkdir -p -- "$work_root" "$output_directory" "$tool_cache"
source_directory="$work_root/source"
grok_work="$work_root/grok"
work_tools="$work_root/tools"
log_file="$work_root/build.log"
mkdir -p -- "$source_directory" "$work_tools"
exec > >(tee -a "$log_file") 2>&1

printf 'Building Xora Code Linux x64 preview for commit %s\n' "$commit"
actual_source_sha256="$(sha256sum "$source_archive" | awk '{print $1}')"
[[ "$actual_source_sha256" == "$source_sha256" ]] || fail "source archive SHA-256 mismatch"
archive_commit="$(python3 - "$source_archive" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    print(archive.pax_headers.get("comment", ""))
PY
)" || fail "source archive is not a Git archive with a commit identity"
[[ "$archive_commit" == "$commit" ]] || fail "Git archive commit identity does not match --commit"

archive_entries="$work_root/source-archive-files.txt"
tar -tzf "$source_archive" > "$archive_entries"
[[ -s "$archive_entries" ]] || fail "source archive is empty"
archive_listing="$work_root/source-archive-listing.txt"
tar -tvzf "$source_archive" > "$archive_listing"
while IFS= read -r listing; do
    [[ "${listing:0:1}" == - || "${listing:0:1}" == d ]] || fail "source archive contains a link or special file"
done < "$archive_listing"
expected_prefix="xora-code-${commit}/"
while IFS= read -r entry; do
    [[ "$entry" != /* && "$entry" != *\\* ]] || fail "source archive contains an unsafe path"
    [[ "$entry" == "$expected_prefix" || "$entry" == "$expected_prefix"* ]] || fail "source archive prefix does not match the commit"
    remainder="${entry#"$expected_prefix"}"
    [[ "$remainder" != .. && "$remainder" != ../* && "$remainder" != */../* && "$remainder" != */.. ]] || fail "source archive contains path traversal"
    [[ "$remainder" != /* && "$remainder" != *//* ]] || fail "source archive contains an ambiguous path"
done < "$archive_entries"
tar -xzf "$source_archive" --strip-components=1 --no-same-owner --no-same-permissions -C "$source_directory"
[[ -f "$source_directory/package.json" && -f "$source_directory/yarn.lock" ]] || fail "extracted source is not an Xora Code repository"
[[ ! -e "$source_directory/.git" && ! -e "$source_directory/node_modules" ]] || fail "source archive contains forbidden repository state"
cmp -s -- "$tool_lock" "$source_directory/build/release/native-preview-tools.lock.json" || fail "external tool lock differs from the committed source"
cmp -s -- "${BASH_SOURCE[0]}" "$source_directory/build/release/native-preview-linux-x64.sh" || fail "running Linux builder differs from the committed source"

download_verified() {
    local url="$1" expected_hash="$2" expected_size="$3" destination="$4"
    local temporary="${destination}.part-$$"
    if [[ -f "$destination" ]]; then
        [[ $(stat -c '%s' "$destination") == "$expected_size" ]] || fail "cached file has the wrong size: $destination"
        [[ $(sha256sum "$destination" | awk '{print $1}') == "$expected_hash" ]] || fail "cached file has the wrong SHA-256: $destination"
        return
    fi
    [[ ! -e "$destination" ]] || fail "tool cache path is not a regular file: $destination"
    rm -f -- "$temporary"
    if ! curl --fail --location --retry 4 --retry-delay 3 --connect-timeout 20 --output "$temporary" "$url"; then
        rm -f -- "$temporary"
        fail "tool download failed: $url"
    fi
    if [[ $(stat -c '%s' "$temporary") != "$expected_size" ]]; then
        rm -f -- "$temporary"
        fail "downloaded file has the wrong size: $url"
    fi
    if [[ $(sha256sum "$temporary" | awk '{print $1}') != "$expected_hash" ]]; then
        rm -f -- "$temporary"
        fail "downloaded file has the wrong SHA-256: $url"
    fi
    mv -- "$temporary" "$destination"
}

node_archive="$tool_cache/$node_archive_name"
node_directory="$work_tools/$node_directory_name"
download_verified "$node_url" "$node_sha256" "$node_size" "$node_archive"
tar -xJf "$node_archive" -C "$work_tools"
[[ -x "$node_directory/bin/node" ]] || fail "verified Node archive did not produce node"

rust_bin_directory="$(dirname -- "$(command -v rustup)")"
export PATH="$node_directory/bin:$rust_bin_directory:$PATH"
[[ $(node --version) == "v${node_version}" ]] || fail "wrong Node version"
corepack enable --install-directory "$node_directory/bin"
corepack prepare "yarn@${yarn_version}" --activate
[[ $(yarn --version) == "$yarn_version" ]] || fail "wrong Yarn version"

export RUSTUP_TOOLCHAIN="${rust_version}-x86_64-unknown-linux-gnu"
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
[[ $(rustc --version | awk '{print $2}') == "$rust_version" ]] || fail "wrong Rust version"
[[ $(rustc -vV | awk '/^host:/ { print $2 }') == x86_64-unknown-linux-gnu ]] || fail "Rust host is not native Linux x64"

# Rustup continues to use its existing RUSTUP_HOME and standard proxy
# variables. Cargo itself is isolated from ~/.cargo/config.toml and may only
# resolve crates.io through Cargo's official sparse index.
cargo_home="$work_tools/cargo-home"
mkdir -p -- "$cargo_home"
cat > "$cargo_home/config.toml" <<'EOF'
[registries.crates-io]
index = "sparse+https://index.crates.io/"
protocol = "sparse"

[net]
retry = 6
git-fetch-with-cli = true

[http]
timeout = 120
EOF
export CARGO_HOME="$cargo_home"

dotslash_root="$work_tools/dotslash-${dotslash_version}-linux-x64"
cargo install dotslash --locked --version "$dotslash_version" --root "$dotslash_root"
export PATH="$dotslash_root/bin:$PATH"
dotslash --version | grep -F "$dotslash_version" >/dev/null || fail "wrong DotSlash version"

protoc_archive="$tool_cache/$protoc_archive_name"
protoc_root="$work_tools/protoc-${protoc_version}-linux-x64"
download_verified "$protoc_url" "$protoc_sha256" "$protoc_size" "$protoc_archive"
mkdir -p -- "$protoc_root"
unzip -q "$protoc_archive" -d "$protoc_root"
[[ -x "$protoc_root/bin/protoc" ]] || fail "verified protoc archive did not produce protoc"
export PATH="$protoc_root/bin:$PATH"
[[ $(protoc --version) == "libprotoc ${protoc_version}" ]] || fail "wrong protoc version"

export GITHUB_SHA="$commit"
export YARN_CACHE_FOLDER="$tool_cache/yarn-cache"
export npm_config_cache="$tool_cache/npm-cache"
export npm_config_python="$(command -v python3)"
export ELECTRON_CACHE="$tool_cache/electron-cache"
export CSC_IDENTITY_AUTO_DISCOVERY=false
export CARGO_INCREMENTAL=0
export CARGO_NET_GIT_FETCH_WITH_CLI=true
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=core.longpaths
export GIT_CONFIG_VALUE_0=true

cd -- "$source_directory"
yarn install --frozen-lockfile --non-interactive
node build/grok/build-sidecar.mjs \
    --work-dir "$grok_work" \
    --target linux-x64 \
    --stage-dir resources/sidecars/grok
node build/grok/smoke-sidecar.mjs --binary resources/sidecars/grok/grok
node build/grok/release-metadata.mjs --verify --stage-dir resources/sidecars/grok --target linux-x64
yarn build
yarn test
node --test build/grok/test/*.test.mjs build/grok/test/*.test.ts
yarn workspace @xora-code/electron-app verify:sidecar:preview
yarn workspace @xora-code/electron-app package:preview:installers --platform linux --arch x64
yarn sbom:preview -- \
    --target linux-x64 \
    --cache-dir "$tool_cache/syft" \
    --output-dir applications/electron/dist/preview-assets \
    --source-dir applications/electron/dist/linux-unpacked

asset_root="$source_directory/applications/electron/dist/preview-assets"
node build/sbom/verify-preview-assets.mjs --target linux-x64 --commit "$commit" --assets-dir "$asset_root"

short_commit="${commit:0:12}"
bundle_name="xora-preview-linux-x64-${short_commit}.tar.gz"
bundle="$output_directory/$bundle_name"
bundle_hash_file="$bundle.sha256.txt"
report="$output_directory/xora-preview-linux-x64-${short_commit}.build.json"
[[ ! -e "$bundle" && ! -e "$bundle_hash_file" && ! -e "$report" ]] || fail "output files already exist"

temporary_bundle="$bundle.part-$$"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -cf - -C "$asset_root" . | gzip -n > "$temporary_bundle"
mv -- "$temporary_bundle" "$bundle"
bundle_sha256="$(sha256sum "$bundle" | awk '{print $1}')"
printf '%s  %s\n' "$bundle_sha256" "$bundle_name" > "$bundle_hash_file"

node_version_output="$(node --version)"
yarn_version_output="$(yarn --version)"
rust_version_output="$(rustc --version)"
dotslash_version_output="$(dotslash --version | head -n 1)"
protoc_version_output="$(protoc --version)"
sidecar_version_output="$(resources/sidecars/grok/grok --version | head -n 1)"
python3 - "$report" "$commit" "$source_sha256" "$bundle_name" "$bundle_sha256" \
    "$node_version_output" "$yarn_version_output" "$rust_version_output" "$dotslash_version_output" \
    "$protoc_version_output" "$sidecar_version_output" <<'PY'
import datetime
import json
import sys

report, commit, source_hash, bundle, bundle_hash, node, yarn, rust, dotslash, protoc, sidecar = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "product": "xora-code",
    "commit": commit,
    "target": "linux-x64",
    "sourceArchiveSha256": source_hash,
    "node": node,
    "yarn": yarn,
    "rust": rust,
    "dotslash": dotslash,
    "protoc": protoc,
    "sidecar": sidecar,
    "bundle": bundle,
    "bundleSha256": bundle_hash,
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
with open(report, "x", encoding="utf-8") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

printf 'XORA_LINUX_BUNDLE=%s\n' "$bundle"
printf 'XORA_LINUX_BUNDLE_SHA256=%s\n' "$bundle_sha256"
printf 'XORA_LINUX_REPORT=%s\n' "$report"
printf 'XORA_LINUX_LOG=%s\n' "$log_file"
