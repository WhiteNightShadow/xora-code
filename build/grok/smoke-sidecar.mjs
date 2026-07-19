#!/usr/bin/env node
// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(scriptDirectory, "acp-initialize-fixture.json");
const lockPath = join(scriptDirectory, "sidecar.lock.json");
const fakeApiKey = "xai-ci-smoke-not-a-real-credential";

function fail(message) {
  throw new Error(`Grok ACP smoke test failed: ${message}`);
}

function binaryArgument() {
  const index = process.argv.indexOf("--binary");
  if (index < 0 || !process.argv[index + 1]) {
    fail("usage: node build/grok/smoke-sidecar.mjs --binary <path>");
  }
  return resolve(process.argv[index + 1]);
}

function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process has already exited.
    }
  }
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const binary = binaryArgument();
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const home = await mkdtemp(join(tmpdir(), "whitenight-grok-smoke-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });

  const version = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0 || !version.stdout.includes(lock.upstream.version)) {
    fail(`--version did not report ${lock.upstream.version}`);
  }

  const child = spawn(binary, lock.runtime.args.map((value) => (value === "<root>" ? workspace : value)), {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: join(home, ".grok"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XAI_API_KEY: fakeApiKey,
      DISABLE_TELEMETRY: "1",
      NO_COLOR: "1",
    },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384).split(fakeApiKey).join("[REDACTED]");
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  const pending = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line, "utf8") > 4 * 1024 * 1024) {
      for (const request of pending.values()) request.reject(new Error("ACP response exceeded 4 MiB"));
      pending.clear();
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      for (const request of pending.values()) request.reject(new Error("non-JSON data appeared on ACP stdout"));
      pending.clear();
      return;
    }
    if (message && Object.hasOwn(message, "id") && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`ACP ${request.method} error: ${JSON.stringify(message.error)}`));
      else request.resolve(message.result);
    }
  });

  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8", (error) => {
        if (!error) return;
        pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  try {
    const initialized = await withTimeout(request("initialize", {
      protocolVersion: fixture.protocolVersion,
      clientCapabilities: fixture.clientCapabilities,
      clientInfo: fixture.clientInfo,
      _meta: {
        startupHints: {
          nonInteractive: true,
          skipGitStatus: true,
          skipProjectLayout: true,
        },
        clientType: "whitenight-code-release-smoke",
        clientVersion: fixture.clientInfo?.version ?? "0.1.0",
      },
    }), 45_000, "initialize");
    if (!initialized || !Array.isArray(initialized.authMethods)) {
      fail("initialize did not return ACP authMethods");
    }
    if (!initialized.authMethods.some((method) => method?.id === "xai.api_key")) {
      fail("initialize did not advertise xai.api_key");
    }
    await withTimeout(request("authenticate", {
      methodId: "xai.api_key",
      _meta: { headless: true },
    }), 30_000, "authenticate");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${message}${stderr ? `; stderr: ${stderr}` : ""}`);
  } finally {
    lines.close();
    try {
      child.stdin.end();
    } catch {
      // Continue to force the process tree down.
    }
    killProcessTree(child);
    await withTimeout(exit, 15_000, "process-tree cleanup");
    await rm(home, { recursive: true, force: true });
  }

  if (child.exitCode === null && child.signalCode === null) fail("sidecar process survived cleanup");
  process.stdout.write(`Verified Grok ${lock.upstream.version}: version, ACP initialize, API-key auth, process cleanup.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
