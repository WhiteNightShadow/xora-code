#!/usr/bin/env python3
# Copyright (c) 2026 Xora Code contributors.
# SPDX-License-Identifier: Apache-2.0

"""Import one previously staged Grok sidecar into a fresh release source tree.

This is deliberately stricter than a general directory copy.  A reusable
boundary must be the exact output shape produced by build/grok/build-sidecar.mjs;
all cryptographic, metadata, ACP and packaging checks still run afterwards.
"""

from __future__ import annotations

import argparse
import os
import stat
from pathlib import Path, PurePosixPath
from typing import NoReturn


NOTICE_FILES = {
    "GROK-BUILD-COMPATIBILITY-PATCHES.md",
    "GROK-BUILD-LICENSE",
    "GROK-BUILD-THIRD-PARTY-NOTICES",
    "GROK-TOOLS-THIRD-PARTY-NOTICES.md",
    "GROK-VENDORED-NOTICE",
    "RIPGREP-SOURCE-BUILD-NOTICE.md",
    "THIRD-PARTY-NOTICES.md",
    "XAI-RATATUI-INLINE-NOTICE",
    "XAI-RATATUI-TEXTAREA-NOTICE",
    "XORA-CODE-LICENSE",
    "XORA-CODE-NOTICE.md",
}


def fail(message: str) -> NoReturn:
    raise SystemExit(f"Staged Grok sidecar import refused: {message}")


def expected_files(target: str) -> set[str]:
    suffix = ".exe" if target == "win32-x64" else ""
    binary = f"grok{suffix}"
    ripgrep = f"rg{suffix}"
    return {
        "README.md",
        "release.json",
        binary,
        f"{binary}.sha256",
        f"packaging-tools/{ripgrep}",
        f"packaging-tools/{ripgrep}.sha256",
        *(f"notices/{name}" for name in NOTICE_FILES),
    }


def assert_absolute_non_root(path: Path, label: str) -> None:
    if not path.is_absolute() or path == Path(path.anchor):
        fail(f"{label} must be an absolute non-root path")


def assert_plain_directory(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    if not stat.S_ISDIR(metadata.st_mode) or is_link_or_reparse(path, metadata):
        fail(f"{label} must be a real directory, not a link: {path}")


def is_link_or_reparse(path: Path, metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    file_attributes = getattr(metadata, "st_file_attributes", 0)
    junction = getattr(path, "is_junction", lambda: False)()
    return stat.S_ISLNK(metadata.st_mode) or path.is_symlink() or junction or bool(file_attributes & reparse_flag)


def inspect_source(source: Path, expected: set[str]) -> None:
    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    for root, directories, files in os.walk(source, topdown=True, followlinks=False):
        root_path = Path(root)
        for name in directories:
            candidate = root_path / name
            metadata = candidate.lstat()
            relative = candidate.relative_to(source).as_posix()
            if not stat.S_ISDIR(metadata.st_mode) or is_link_or_reparse(candidate, metadata):
                fail(f"source contains a linked or special directory: {relative}")
            actual_directories.add(relative)
        for name in files:
            candidate = root_path / name
            metadata = candidate.lstat()
            relative = candidate.relative_to(source).as_posix()
            if not stat.S_ISREG(metadata.st_mode) or is_link_or_reparse(candidate, metadata):
                fail(f"source contains a link or special file: {relative}")
            if metadata.st_nlink != 1:
                fail(f"source contains a hard-linked file: {relative}")
            if metadata.st_size <= 0:
                fail(f"source contains an empty file: {relative}")
            # Defend against platform separator and normalization ambiguity.
            if PurePosixPath(relative).as_posix() != relative or "\\" in relative:
                fail(f"source contains an ambiguous path: {relative}")
            actual_files.add(relative)

    expected_directories = {"notices", "packaging-tools"}
    if actual_directories != expected_directories:
        extra = sorted(actual_directories - expected_directories)
        missing = sorted(expected_directories - actual_directories)
        fail(f"source directory structure mismatch (extra={extra}, missing={missing})")
    if actual_files != expected:
        extra = sorted(actual_files - expected)
        missing = sorted(expected - actual_files)
        fail(f"source file structure mismatch (extra={extra}, missing={missing})")


def assert_fresh_destination(source: Path, destination: Path) -> None:
    assert_plain_directory(destination, "destination")
    entries = list(destination.iterdir())
    if len(entries) != 1 or entries[0].name != "README.md":
        fail("destination is not a fresh source sidecar directory")
    readme = entries[0]
    metadata = readme.lstat()
    if not stat.S_ISREG(metadata.st_mode) or is_link_or_reparse(readme, metadata):
        fail("destination README.md must be a non-link regular file")
    if source.joinpath("README.md").read_bytes() != readme.read_bytes():
        fail("staged README.md differs from the committed source")


def copy_regular_file(source: Path, destination: Path, mode: int) -> None:
    source_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    source_descriptor = os.open(source, source_flags)
    try:
        source_metadata = os.fstat(source_descriptor)
        current_metadata = source.lstat()
        if (
            not stat.S_ISREG(source_metadata.st_mode)
            or source_metadata.st_nlink != 1
            or is_link_or_reparse(source, current_metadata)
            or (source_metadata.st_dev, source_metadata.st_ino) != (current_metadata.st_dev, current_metadata.st_ino)
        ):
            fail(f"source changed or became unsafe during import: {source}")
        destination_descriptor = os.open(destination, destination_flags, mode)
        try:
            while True:
                block = os.read(source_descriptor, 1024 * 1024)
                if not block:
                    break
                view = memoryview(block)
                while view:
                    written = os.write(destination_descriptor, view)
                    view = view[written:]
            os.fsync(destination_descriptor)
        finally:
            os.close(destination_descriptor)
    finally:
        os.close(source_descriptor)
    destination.chmod(mode)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--target", required=True, choices=("linux-x64", "win32-x64"))
    options = parser.parse_args()

    source = Path(options.source)
    destination = Path(options.destination)
    assert_absolute_non_root(source, "source")
    assert_absolute_non_root(destination, "destination")
    assert_plain_directory(source, "source")
    expected = expected_files(options.target)
    inspect_source(source, expected)
    assert_fresh_destination(source, destination)

    # Resolve only after link rejection, then refuse recursive/overlapping copy.
    source_real = source.resolve(strict=True)
    destination_real = destination.resolve(strict=True)
    if source_real == destination_real or source_real in destination_real.parents or destination_real in source_real.parents:
        fail("source and destination must not overlap")

    for relative in sorted(expected - {"README.md"}):
        source_file = source / relative
        destination_file = destination / relative
        destination_file.parent.mkdir(parents=True, exist_ok=True)
        copy_regular_file(
            source_file,
            destination_file,
            0o755 if relative in {"grok", "packaging-tools/rg"} else 0o644,
        )

    # A post-copy scan proves the destination shape did not gain extra content.
    inspect_source(destination, expected)


if __name__ == "__main__":
    main()
