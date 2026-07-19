import type {
  ProviderApiBackend,
  ProviderAuth,
  ProviderKind,
  ProviderProfile,
} from "./dto.js";
import { isSensitiveKey } from "./redaction.js";

const PROVIDERS: ProviderKind[] = [
  "xai",
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
  "custom",
];
const API_BACKENDS: ProviderApiBackend[] = ["responses", "chat_completions", "messages"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const TEMPLATE_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/gu;
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export interface ProviderProfileIssue {
  path: string;
  code: string;
  message: string;
}

export class ProviderProfileValidationError extends Error {
  readonly issues: readonly ProviderProfileIssue[];

  constructor(issues: readonly ProviderProfileIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ProviderProfileValidationError";
    this.issues = issues;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127;
}

function validateUrl(value: unknown, issues: ProviderProfileIssue[]): string | undefined {
  if (!nonEmptyString(value)) {
    issues.push({ path: "baseUrl", code: "required", message: "must be a non-empty URL" });
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ path: "baseUrl", code: "invalid_url", message: "must be an absolute URL" });
    return undefined;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    issues.push({
      path: "baseUrl",
      code: "insecure_url",
      message: "must use HTTPS; HTTP is allowed only for loopback endpoints",
    });
  }
  if (url.username || url.password) {
    issues.push({ path: "baseUrl", code: "embedded_secret", message: "must not contain user info" });
  }
  if (url.search || url.hash) {
    issues.push({ path: "baseUrl", code: "unexpected_component", message: "must not contain query or fragment" });
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    issues.push({ path: "baseUrl", code: "metadata_endpoint", message: "cloud metadata endpoints are forbidden" });
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function validateAuth(value: unknown, issues: ProviderProfileIssue[]): ProviderAuth | undefined {
  const auth = record(value);
  if (!auth || !nonEmptyString(auth.kind)) {
    issues.push({ path: "auth", code: "required", message: "must declare an authentication kind" });
    return undefined;
  }
  if (auth.kind === "none") return { kind: "none" };
  if (auth.kind === "api-key") {
    if (
      !nonEmptyString(auth.secretRef) ||
      !SECRET_REF_PATTERN.test(auth.secretRef) ||
      /^(?:xai|sk)-/u.test(auth.secretRef)
    ) {
      issues.push({
        path: "auth.secretRef",
        code: "invalid",
        message: "must be an opaque credential-vault reference, never a key value",
      });
    }
    if (!nonEmptyString(auth.envName) || !ENV_PATTERN.test(auth.envName)) {
      issues.push({ path: "auth.envName", code: "invalid", message: "must be an uppercase environment variable name" });
    }
    if (nonEmptyString(auth.secretRef) && nonEmptyString(auth.envName) && ENV_PATTERN.test(auth.envName)) {
      return { kind: "api-key", secretRef: auth.secretRef, envName: auth.envName };
    }
    return undefined;
  }
  if (auth.kind === "oauth" || auth.kind === "subscription") {
    if (auth.accountId !== undefined && !nonEmptyString(auth.accountId)) {
      issues.push({ path: "auth.accountId", code: "invalid", message: "must be a non-empty string" });
    }
    return auth.accountId === undefined
      ? { kind: auth.kind }
      : { kind: auth.kind, accountId: String(auth.accountId) };
  }
  issues.push({ path: "auth.kind", code: "unsupported", message: `unsupported auth kind ${auth.kind}` });
  return undefined;
}

function validateHeaders(
  value: unknown,
  issues: ProviderProfileIssue[],
  auth: ProviderAuth | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) {
    issues.push({ path: "headers", code: "invalid", message: "must be a string map" });
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof headerValue !== "string") {
      issues.push({ path: `headers.${name}`, code: "invalid", message: "must be a valid header name and string value" });
      continue;
    }
    if (headerValue.includes("\r") || headerValue.includes("\n")) {
      issues.push({ path: `headers.${name}`, code: "invalid", message: "must not contain CR or LF" });
      continue;
    }
    const referencedEnvironment = [...headerValue.matchAll(TEMPLATE_PATTERN)].map((match) => match[1]!);
    if (headerValue.includes("${") && referencedEnvironment.length === 0) {
      issues.push({
        path: `headers.${name}`,
        code: "invalid_template",
        message: "environment templates must use ${UPPERCASE_NAME} without a default value",
      });
      continue;
    }
    if (
      referencedEnvironment.some(
        (environmentName) => auth?.kind !== "api-key" || environmentName !== auth.envName,
      )
    ) {
      issues.push({
        path: `headers.${name}`,
        code: "undeclared_secret",
        message: "header templates may reference only the profile's injected API-key environment variable",
      });
      continue;
    }
    const looksLikeLiteralSecret =
      isSensitiveKey(name) ||
      /\b(?:Bearer\s+|xai-|sk-)[A-Za-z0-9._~+/=-]{8,}/iu.test(headerValue);
    if (looksLikeLiteralSecret && referencedEnvironment.length === 0) {
      issues.push({
        path: `headers.${name}`,
        code: "plaintext_secret",
        message: "sensitive headers must use an ${ENV_VAR} template",
      });
      continue;
    }
    output[name] = headerValue;
  }
  return output;
}

export function validateProviderProfile(input: unknown): ProviderProfile {
  const issues: ProviderProfileIssue[] = [];
  const value = record(input);
  if (!value) throw new ProviderProfileValidationError([{ path: "$", code: "invalid", message: "must be an object" }]);

  if (!nonEmptyString(value.id) || !ID_PATTERN.test(value.id)) {
    issues.push({ path: "id", code: "invalid", message: "must be 1-64 URL-safe characters" });
  }
  if (!nonEmptyString(value.displayName)) {
    issues.push({ path: "displayName", code: "required", message: "must be non-empty" });
  }
  if (!nonEmptyString(value.provider) || !PROVIDERS.includes(value.provider as ProviderKind)) {
    issues.push({ path: "provider", code: "unsupported", message: "is not a supported provider kind" });
  }
  if (!nonEmptyString(value.model)) {
    issues.push({ path: "model", code: "required", message: "must be non-empty" });
  }
  if (!nonEmptyString(value.apiBackend) || !API_BACKENDS.includes(value.apiBackend as ProviderApiBackend)) {
    issues.push({ path: "apiBackend", code: "unsupported", message: "must be responses, chat_completions, or messages" });
  }

  const baseUrl = validateUrl(value.baseUrl, issues);
  const auth = validateAuth(value.auth, issues);
  const headers = validateHeaders(value.headers, issues, auth);
  if (baseUrl && auth) {
    const url = new URL(baseUrl);
    if (auth.kind === "none" && !isLoopback(url.hostname)) {
      issues.push({
        path: "auth.kind",
        code: "credential_fallback_risk",
        message: "no-auth profiles are allowed only on loopback endpoints",
      });
    }
    if (auth.kind === "oauth" || auth.kind === "subscription") {
      const officialHost = url.hostname === "api.x.ai" || url.hostname === "cli-chat-proxy.grok.com";
      if (value.provider !== "xai" || !officialHost) {
        issues.push({
          path: "auth.kind",
          code: "credential_scope",
          message: "OAuth/subscription credentials may be used only with official xAI endpoints",
        });
      }
    }
  }
  const capabilitiesInput = record(value.capabilities);
  if (value.capabilities !== undefined && !capabilitiesInput) {
    issues.push({ path: "capabilities", code: "invalid", message: "must be an object" });
  }
  for (const field of ["contextWindow", "maxCompletionTokens"] as const) {
    const fieldValue = capabilitiesInput?.[field];
    if (fieldValue !== undefined && (!Number.isSafeInteger(fieldValue) || Number(fieldValue) <= 0)) {
      issues.push({ path: `capabilities.${field}`, code: "invalid", message: "must be a positive safe integer" });
    }
  }

  if (issues.length > 0 || !baseUrl || !auth) throw new ProviderProfileValidationError(issues);

  const capabilities = capabilitiesInput
    ? {
        ...(typeof capabilitiesInput.vision === "boolean" ? { vision: capabilitiesInput.vision } : {}),
        ...(typeof capabilitiesInput.toolUse === "boolean" ? { toolUse: capabilitiesInput.toolUse } : {}),
        ...(typeof capabilitiesInput.reasoning === "boolean" ? { reasoning: capabilitiesInput.reasoning } : {}),
        ...(typeof capabilitiesInput.backendSearch === "boolean"
          ? { backendSearch: capabilitiesInput.backendSearch }
          : {}),
        ...(Number.isSafeInteger(capabilitiesInput.contextWindow)
          ? { contextWindow: Number(capabilitiesInput.contextWindow) }
          : {}),
        ...(Number.isSafeInteger(capabilitiesInput.maxCompletionTokens)
          ? { maxCompletionTokens: Number(capabilitiesInput.maxCompletionTokens) }
          : {}),
      }
    : undefined;

  return {
    id: String(value.id),
    displayName: String(value.displayName).trim(),
    provider: value.provider as ProviderKind,
    model: String(value.model).trim(),
    baseUrl,
    apiBackend: value.apiBackend as ProviderApiBackend,
    auth,
    ...(nonEmptyString(value.description) ? { description: value.description.trim() } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(capabilities && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\\u2028", "\\u2028")
    .replaceAll("\\u2029", "\\u2029");
}

function tomlInlineTable(value: Record<string, string>): string {
  return `{ ${Object.keys(value)
    .sort()
    .map((key) => `${tomlString(key)} = ${tomlString(value[key]!)}`)
    .join(", ")} }`;
}

export interface ManagedTomlOptions {
  setDefault?: boolean;
}

/**
 * Generates only non-secret Grok model configuration. The caller injects the
 * credential referenced by `auth.secretRef` into `auth.envName` at spawn time.
 */
export function generateManagedGrokToml(
  profileInput: ProviderProfile,
  options: ManagedTomlOptions = {},
): string {
  const profile = validateProviderProfile(profileInput);
  const lines = [
    "# Managed by WhiteNight Code. Do not add plaintext credentials.",
    `[model.${tomlString(profile.id)}]`,
    `model = ${tomlString(profile.model)}`,
    `base_url = ${tomlString(profile.baseUrl)}`,
    `name = ${tomlString(profile.displayName)}`,
    `api_backend = ${tomlString(profile.apiBackend)}`,
  ];
  if (profile.description) lines.push(`description = ${tomlString(profile.description)}`);
  if (profile.auth.kind === "api-key") lines.push(`env_key = ${tomlString(profile.auth.envName)}`);
  if (profile.headers && Object.keys(profile.headers).length > 0) {
    lines.push(`extra_headers = ${tomlInlineTable(profile.headers)}`);
  }
  if (profile.capabilities?.contextWindow) {
    lines.push(`context_window = ${profile.capabilities.contextWindow}`);
  }
  if (profile.capabilities?.maxCompletionTokens) {
    lines.push(`max_completion_tokens = ${profile.capabilities.maxCompletionTokens}`);
  }
  if (profile.capabilities?.backendSearch !== undefined) {
    lines.push(`supports_backend_search = ${profile.capabilities.backendSearch}`);
  }
  if (options.setDefault) lines.push("", "[models]", `default = ${tomlString(profile.id)}`);
  return `${lines.join("\n")}\n`;
}
