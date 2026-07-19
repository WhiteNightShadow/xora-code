#!/usr/bin/env node
// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return resolve(process.argv[index + 1]);
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`release artifact must not be a symlink: ${path}`);
    if (metadata.isDirectory()) files.push(...(await walk(path)));
    else if (metadata.isFile()) files.push(path);
  }
  return files;
}

const input = argument("input");
const output = argument("output");
await mkdir(output, { recursive: true });
const seen = new Set();
for (const source of await walk(input)) {
  const name = basename(source);
  if (seen.has(name)) throw new Error(`duplicate release artifact name: ${name}`);
  seen.add(name);
  await copyFile(source, join(output, name), constants.COPYFILE_EXCL);
}
if (seen.size === 0) throw new Error("no release artifacts were collected");
process.stdout.write(`Collected ${seen.size} unique release artifacts.\n`);
