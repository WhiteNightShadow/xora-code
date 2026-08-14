#!/usr/bin/env python3
# Copyright (c) 2026 Xora Code contributors.
# SPDX-License-Identifier: Apache-2.0

"""Verify and safely extract an immutable language-plugin seed archive."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import unicodedata


MAX_MEMBERS = 50_000
MAX_EXPANDED_BYTES = 1_073_741_824
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


class PluginSeedError(Exception):
    """Raised when the plugin seed cannot be trusted or safely extracted."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_segment(segment: str) -> None:
    if not segment or segment in {".", ".."}:
        raise PluginSeedError("archive contains an empty or dot path segment")
    if any(ord(character) < 32 for character in segment):
        raise PluginSeedError("archive path contains a control character")
    if "\x00" in segment or "\\" in segment or ":" in segment:
        raise PluginSeedError("archive path is not portable across release targets")
    if segment.endswith((" ", ".")):
        raise PluginSeedError("archive path has a Windows-ambiguous suffix")
    if segment.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES:
        raise PluginSeedError("archive path uses a Windows reserved name")


def normalized_relative_path(member: tarfile.TarInfo) -> PurePosixPath | None:
    name = member.name
    if not name or name.startswith("/") or "//" in name or "\\" in name:
        raise PluginSeedError(f"unsafe plugin archive path: {name!r}")
    path = PurePosixPath(name)
    parts = path.parts
    if not parts or parts[0] != "plugins":
        raise PluginSeedError(f"plugin archive entry is outside plugins/: {name!r}")
    for segment in parts:
        validate_segment(segment)
    if len(parts) == 1:
        if not member.isdir():
            raise PluginSeedError("plugins archive root must be a directory")
        return None
    relative = PurePosixPath(*parts[1:])
    if relative.name.casefold().endswith(".map"):
        raise PluginSeedError(f"plugin archive contains a source map: {name!r}")
    return relative


def validated_members(archive: tarfile.TarFile) -> tuple[list[tuple[tarfile.TarInfo, PurePosixPath]], int]:
    members = archive.getmembers()
    if not members:
        raise PluginSeedError("plugin archive is empty")
    if len(members) > MAX_MEMBERS:
        raise PluginSeedError("plugin archive contains too many entries")

    accepted: list[tuple[tarfile.TarInfo, PurePosixPath]] = []
    kinds: dict[str, str] = {}
    spellings: dict[str, str] = {}
    expanded_bytes = 0
    regular_files = 0
    for member in members:
        relative = normalized_relative_path(member)
        if relative is None:
            continue
        if not (member.isdir() or member.isreg()):
            raise PluginSeedError(f"plugin archive contains a link or special file: {member.name!r}")
        relative_text = relative.as_posix()
        key = unicodedata.normalize("NFC", relative_text).casefold()
        kind = "directory" if member.isdir() else "file"
        parents = [parent for parent in relative.parents if parent != PurePosixPath(".")]
        for parent in reversed(parents):
            parent_text = parent.as_posix()
            parent_key = unicodedata.normalize("NFC", parent_text).casefold()
            if parent_key in spellings and spellings[parent_key] != parent_text:
                raise PluginSeedError(f"plugin archive contains a case-colliding path: {member.name!r}")
            if kinds.get(parent_key) == "file":
                raise PluginSeedError(f"plugin archive places a child below a file: {member.name!r}")
            spellings.setdefault(parent_key, parent_text)
            kinds.setdefault(parent_key, "implicit-directory")
        if key in spellings and spellings[key] != relative_text:
            raise PluginSeedError(f"plugin archive contains a case-colliding path: {member.name!r}")
        existing_kind = kinds.get(key)
        if existing_kind is not None and not (kind == "directory" and existing_kind == "implicit-directory"):
            raise PluginSeedError(f"plugin archive contains a duplicate path: {member.name!r}")
        if kind == "file":
            prefix = f"{key}/"
            if any(existing.startswith(prefix) for existing in kinds):
                raise PluginSeedError(f"plugin archive replaces a directory with a file: {member.name!r}")
            if member.size < 0:
                raise PluginSeedError("plugin archive contains an invalid file size")
            expanded_bytes += member.size
            regular_files += 1
            if expanded_bytes > MAX_EXPANDED_BYTES:
                raise PluginSeedError("plugin archive expands beyond the one-GiB safety limit")
        spellings.setdefault(key, relative_text)
        kinds[key] = kind
        accepted.append((member, relative))

    if regular_files == 0:
        raise PluginSeedError("plugin archive contains no regular files")
    return accepted, expanded_bytes


def assert_clean_destination(destination: Path) -> None:
    if destination.is_symlink():
        raise PluginSeedError("plugin destination must not be a symbolic link")
    if not destination.is_dir():
        raise PluginSeedError("plugin destination does not exist or is not a directory")
    existing = list(destination.iterdir())
    if not existing:
        return
    if len(existing) != 1 or existing[0].name != ".gitkeep" or not existing[0].is_file() or existing[0].is_symlink():
        raise PluginSeedError("refusing to replace a non-empty plugins directory")


def extract_archive(archive_path: Path, destination: Path, members: list[tuple[tarfile.TarInfo, PurePosixPath]]) -> None:
    keep_file = destination / ".gitkeep"
    if keep_file.exists():
        keep_file.unlink()
    destination_resolved = destination.resolve(strict=True)

    with tarfile.open(archive_path, "r:gz") as archive:
        for member, relative in members:
            target = destination.joinpath(*relative.parts)
            target_parent = target.parent
            target_parent.mkdir(parents=True, exist_ok=True)
            resolved_parent = target_parent.resolve(strict=True)
            if os.path.commonpath((str(destination_resolved), str(resolved_parent))) != str(destination_resolved):
                raise PluginSeedError(f"plugin archive escaped its destination: {member.name!r}")
            if member.isdir():
                target.mkdir(exist_ok=True)
                target.chmod(member.mode & 0o777 or 0o755)
                continue
            source = archive.extractfile(member)
            if source is None:
                raise PluginSeedError(f"plugin archive file cannot be read: {member.name!r}")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(target, flags, member.mode & 0o777 or 0o644)
            with source, os.fdopen(descriptor, "wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            target.chmod(member.mode & 0o777 or 0o644)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--destination", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    if len(arguments.sha256) != 64 or any(character not in "0123456789abcdef" for character in arguments.sha256):
        raise PluginSeedError("plugin SHA-256 must be 64 lowercase hexadecimal characters")
    if not arguments.archive.is_file() or arguments.archive.is_symlink():
        raise PluginSeedError("plugin archive is missing or is a symbolic link")
    actual_sha256 = sha256_file(arguments.archive)
    if actual_sha256 != arguments.sha256:
        raise PluginSeedError("plugin archive SHA-256 mismatch")
    assert_clean_destination(arguments.destination)
    try:
        with tarfile.open(arguments.archive, "r:gz") as archive:
            members, expanded_bytes = validated_members(archive)
    except (tarfile.TarError, OSError) as error:
        raise PluginSeedError(f"plugin archive is not a valid gzip-compressed tar archive: {error}") from error
    extract_archive(arguments.archive, arguments.destination, members)
    file_count = sum(1 for member, _relative in members if member.isreg())
    print(
        f"plugin-seed: verified sha256={actual_sha256} files={file_count} "
        f"expandedBytes={expanded_bytes}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PluginSeedError as error:
        print(f"plugin-seed refused: {error}", file=sys.stderr)
        raise SystemExit(1)
