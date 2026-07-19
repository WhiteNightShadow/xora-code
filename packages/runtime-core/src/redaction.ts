const DEFAULT_MARKER = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "cookie",
  "setcookie",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret")
  );
}

export interface SecretRedactorOptions {
  marker?: string;
  knownSecrets?: Iterable<string>;
}

export class SecretRedactor {
  readonly #marker: string;
  readonly #knownSecrets = new Set<string>();

  constructor(options: SecretRedactorOptions = {}) {
    this.#marker = options.marker ?? DEFAULT_MARKER;
    for (const secret of options.knownSecrets ?? []) this.register(secret);
  }

  register(secret: string): void {
    if (secret.length > 0) this.#knownSecrets.add(secret);
  }

  redactText(text: string): string {
    let redacted = text;
    const secrets = [...this.#knownSecrets].sort((left, right) => right.length - left.length);
    for (const secret of secrets) redacted = redacted.split(secret).join(this.#marker);

    return redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${this.#marker}`)
      .replace(/\b(?:xai|sk)-[A-Za-z0-9_-]{8,}\b/gu, this.#marker)
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]*/giu,
        `$1${this.#marker}`,
      )
      .replace(
        /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu,
        `$1${this.#marker}:${this.#marker}@`,
      );
  }

  redactValue<T>(value: T): T {
    return this.#redactValue(value, new Map<object, unknown>()) as T;
  }

  #redactValue(value: unknown, seen: Map<object, unknown>): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";

    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      for (const item of value) output.push(this.#redactValue(item, seen));
      return output;
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      const output: Record<string, unknown> = {};
      seen.set(value, output);
      output.name = value.name;
      output.message = this.redactText(value.message);
      if (value.stack) output.stack = this.redactText(value.stack);
      return output;
    }

    const output: Record<string, unknown> = {};
    seen.set(value, output);
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? this.#marker : this.#redactValue(item, seen);
    }
    return output;
  }
}

export function redactSecrets<T>(value: T, knownSecrets: Iterable<string> = []): T {
  return new SecretRedactor({ knownSecrets }).redactValue(value);
}
