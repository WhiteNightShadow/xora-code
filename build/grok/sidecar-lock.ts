import { readFile } from "node:fs/promises";

export interface GrokSidecarTarget {
  rustTarget: string;
  executableSuffix: "" | ".exe";
}

export interface GrokSidecarLock {
  schemaVersion: 1;
  upstream: {
    repository: string;
    commit: string;
    sourceRevision: string;
    version: string;
    license: "Apache-2.0";
  };
  toolchain: {
    rust: string;
    dotslash: string;
    protoc: string;
    cargoProfile: string;
    cargoPackage: string;
    cargoBinary: string;
  };
  bundledTools: {
    ripgrep: {
      package: "ripgrep";
      version: string;
      binary: "rg";
      source: "crates.io";
      features: readonly ["pcre2"];
    };
  };
  runtime: {
    packagedBinaryName: string;
    args: string[];
    transport: "stdio";
    protocol: "acp";
  };
  targets: Record<string, GrokSidecarTarget>;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const PROTOC_VERSION_PATTERN = /^\d+\.\d+$/u;

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, path: string): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value[key] as string;
}

export function validateGrokSidecarLock(input: unknown): GrokSidecarLock {
  const root = asRecord(input, "$lock");
  if (root.schemaVersion !== 1) throw new Error("$lock.schemaVersion must be 1");

  const upstream = asRecord(root.upstream, "$lock.upstream");
  const repository = stringField(upstream, "repository", "$lock.upstream");
  const commit = stringField(upstream, "commit", "$lock.upstream");
  const sourceRevision = stringField(upstream, "sourceRevision", "$lock.upstream");
  const version = stringField(upstream, "version", "$lock.upstream");
  if (repository !== "https://github.com/xai-org/grok-build") {
    throw new Error("$lock.upstream.repository must be the official Grok Build repository");
  }
  if (!SHA_PATTERN.test(commit) || !SHA_PATTERN.test(sourceRevision)) {
    throw new Error("upstream commit and sourceRevision must be full lowercase SHA-1 values");
  }
  if (!VERSION_PATTERN.test(version)) throw new Error("upstream version must be SemVer");
  if (upstream.license !== "Apache-2.0") throw new Error("upstream license must be Apache-2.0");

  const toolchain = asRecord(root.toolchain, "$lock.toolchain");
  const rust = stringField(toolchain, "rust", "$lock.toolchain");
  const dotslash = stringField(toolchain, "dotslash", "$lock.toolchain");
  const protoc = stringField(toolchain, "protoc", "$lock.toolchain");
  const cargoProfile = stringField(toolchain, "cargoProfile", "$lock.toolchain");
  const cargoPackage = stringField(toolchain, "cargoPackage", "$lock.toolchain");
  const cargoBinary = stringField(toolchain, "cargoBinary", "$lock.toolchain");
  if (!VERSION_PATTERN.test(rust)) throw new Error("toolchain.rust must be an exact version");
  if (!VERSION_PATTERN.test(dotslash)) throw new Error("toolchain.dotslash must be an exact version");
  if (!PROTOC_VERSION_PATTERN.test(protoc)) throw new Error("toolchain.protoc must be an exact major.minor version");

  const bundledTools = asRecord(root.bundledTools, "$lock.bundledTools");
  const ripgrep = asRecord(bundledTools.ripgrep, "$lock.bundledTools.ripgrep");
  const ripgrepVersion = stringField(ripgrep, "version", "$lock.bundledTools.ripgrep");
  if (ripgrep.package !== "ripgrep" || ripgrep.binary !== "rg" || ripgrep.source !== "crates.io") {
    throw new Error("bundled ripgrep must be the crates.io ripgrep package and rg binary");
  }
  if (!VERSION_PATTERN.test(ripgrepVersion)) {
    throw new Error("bundledTools.ripgrep.version must be an exact version");
  }
  if (!Array.isArray(ripgrep.features) || ripgrep.features.length !== 1 || ripgrep.features[0] !== "pcre2") {
    throw new Error("bundledTools.ripgrep.features must be exactly [\"pcre2\"]");
  }

  const runtime = asRecord(root.runtime, "$lock.runtime");
  const packagedBinaryName = stringField(runtime, "packagedBinaryName", "$lock.runtime");
  if (!Array.isArray(runtime.args) || !runtime.args.every((argument) => typeof argument === "string")) {
    throw new Error("$lock.runtime.args must be a string array");
  }
  if (runtime.transport !== "stdio" || runtime.protocol !== "acp") {
    throw new Error("Grok sidecar runtime must use ACP over stdio");
  }
  const args = [...runtime.args];
  const expectedArgs = [
    "--no-auto-update",
    "--cwd",
    "<root>",
    "agent",
    "--no-leader",
    "stdio",
  ];
  if (args.join("\u0000") !== expectedArgs.join("\u0000")) {
    throw new Error("Grok sidecar args must bind <root>, disable updates/leader mode, and launch ACP stdio");
  }
  if (packagedBinaryName !== "grok") throw new Error("Grok sidecar packaged binary name must be grok");

  const targetsInput = asRecord(root.targets, "$lock.targets");
  if (Object.keys(targetsInput).length === 0) throw new Error("$lock.targets must not be empty");
  const targets: Record<string, GrokSidecarTarget> = {};
  for (const [name, candidate] of Object.entries(targetsInput)) {
    const target = asRecord(candidate, `$lock.targets.${name}`);
    const rustTarget = stringField(target, "rustTarget", `$lock.targets.${name}`);
    if (target.executableSuffix !== "" && target.executableSuffix !== ".exe") {
      throw new Error(`$lock.targets.${name}.executableSuffix must be empty or .exe`);
    }
    const expectedSuffix = name.startsWith("win32-") ? ".exe" : "";
    if (target.executableSuffix !== expectedSuffix) {
      throw new Error(`$lock.targets.${name}.executableSuffix must be ${JSON.stringify(expectedSuffix)}`);
    }
    targets[name] = { rustTarget, executableSuffix: target.executableSuffix };
  }
  for (const requiredTarget of [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ]) {
    if (!targets[requiredTarget]) throw new Error(`$lock.targets is missing ${requiredTarget}`);
  }

  return {
    schemaVersion: 1,
    upstream: {
      repository,
      commit,
      sourceRevision,
      version,
      license: "Apache-2.0",
    },
    toolchain: { rust, dotslash, protoc, cargoProfile, cargoPackage, cargoBinary },
    bundledTools: {
      ripgrep: {
        package: "ripgrep",
        version: ripgrepVersion,
        binary: "rg",
        source: "crates.io",
        features: ["pcre2"],
      },
    },
    runtime: {
      packagedBinaryName,
      args,
      transport: "stdio",
      protocol: "acp",
    },
    targets,
  };
}

export async function loadGrokSidecarLock(path: string | URL): Promise<GrokSidecarLock> {
  return validateGrokSidecarLock(JSON.parse(await readFile(path, "utf8")));
}
