#!/usr/bin/env node
// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
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

function binaryInvocation() {
  const index = process.argv.indexOf("--binary");
  if (index < 0 || !process.argv[index + 1]) {
    fail("usage: node build/grok/smoke-sidecar.mjs --binary <path> [--binary-arg <value>]");
  }
  const args = [];
  for (let argumentIndex = 2; argumentIndex < process.argv.length; argumentIndex += 1) {
    if (process.argv[argumentIndex] !== "--binary-arg") continue;
    if (!process.argv[argumentIndex + 1]) fail("--binary-arg requires a value");
    args.push(process.argv[argumentIndex + 1]);
    argumentIndex += 1;
  }
  return { binary: resolve(process.argv[index + 1]), args };
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
  const { binary, args: binaryArgs } = binaryInvocation();
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const home = await mkdtemp(join(tmpdir(), "whitenight-grok-smoke-"));
  const workspace = join(home, "workspace");
  const debugFile = process.env.XORA_SIDECAR_SMOKE_DEBUG === "1"
    ? join(home, "grok-debug.log")
    : undefined;
  await mkdir(workspace, { recursive: true });

  const version = spawnSync(binary, [...binaryArgs, "--version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0 || !version.stdout.includes(lock.upstream.version)) {
    fail(`--version did not report ${lock.upstream.version}`);
  }

  // The smoke test validates the local ACP contract, not availability of the
  // public model service. Grok eagerly fetches /models before it reads the
  // initialize request, which can otherwise turn an offline runner into a
  // pair of 30-second network timeouts. Keep that prefetch deterministic and
  // confined to loopback.
  const modelServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("connection", "close");
    if (request.method === "GET" && pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"object":"list","data":[]}');
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":{"message":"not available in the ACP smoke test"}}');
  });
  await new Promise((resolveListen, rejectListen) => {
    modelServer.once("error", rejectListen);
    modelServer.listen(0, "127.0.0.1", resolveListen);
  });
  const modelAddress = modelServer.address();
  if (!modelAddress || typeof modelAddress === "string") fail("could not start the loopback model fixture");

  const runtimeArgs = lock.runtime.args.map((value) => (value === "<root>" ? workspace : value));
  if (debugFile) runtimeArgs.push("--debug", "--debug-file", debugFile);
  const child = spawn(binary, [...binaryArgs, ...runtimeArgs], {
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
      GROK_XAI_API_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1`,
      DISABLE_TELEMETRY: "1",
      NO_COLOR: "1",
    },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384).split(fakeApiKey).join("[REDACTED]");
  });
  const pending = new Map();
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      const reason = new Error(
        `sidecar exited before completing ACP requests (code ${code ?? "none"}, signal ${signal ?? "none"})`,
      );
      for (const request of pending.values()) request.reject(reason);
      pending.clear();
      resolveExit({ code, signal });
    });
  });

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
      if (message.error) {
        const error = new Error(`ACP ${request.method} error: ${JSON.stringify(message.error)}`);
        error.rpcCode = message.error.code;
        error.rpcData = message.error.data;
        request.reject(error);
      }
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
        clientType: "xora-code-release-smoke",
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

    // This extension is the non-interrupting transport used by Xora's
    // "guide current task" action. A deliberately missing session must reach
    // the registered handler and fail with invalid params; method-not-found
    // would mean the packaged binary advertises code that ACP cannot route.
    try {
      await withTimeout(request("_x.ai/interject", {
        sessionId: "xora-sidecar-smoke-missing-session",
        text: "contract probe",
        interjectionId: "xora-sidecar-smoke-interjection",
        content: [{ type: "text", text: "contract probe" }],
      }), 15_000, "_x.ai/interject contract probe");
      fail("_x.ai/interject unexpectedly accepted a missing session");
    } catch (error) {
      if (error?.rpcCode !== -32602 || !String(error?.rpcData ?? "").includes("session not found")) {
        throw error;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let debug = "";
    if (debugFile) {
      try {
        debug = (await readFile(debugFile, "utf8"))
          .slice(-16_384)
          .split(fakeApiKey)
          .join("[REDACTED]");
      } catch {
        // The sidecar can fail before creating its debug log.
      }
    }
    fail(`${message}${stderr ? `; stderr: ${stderr}` : ""}${debug ? `; debug: ${debug}` : ""}`);
  } finally {
    lines.close();
    try {
      child.stdin.end();
    } catch {
      // Continue to force the process tree down.
    }
    killProcessTree(child);
    await withTimeout(exit, 15_000, "process-tree cleanup");
    modelServer.closeAllConnections();
    await new Promise((resolveClose) => modelServer.close(() => resolveClose()));
    await rm(home, { recursive: true, force: true });
  }

  if (child.exitCode === null && child.signalCode === null) fail("sidecar process survived cleanup");
  process.stdout.write(`Verified Grok ${lock.upstream.version}: version, ACP initialize, API-key auth, _x.ai/interject, process cleanup.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
