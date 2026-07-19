/** RFC 8785 JSON Canonicalization Scheme for already-parsed JSON values. */

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${path} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired low surrogate`);
    }
  }
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains the non-JSON type ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`${path} contains a sparse array`);
      }
      const extraKeys = Object.keys(value).filter((key) => !/^(?:0|[1-9]\d*)$/u.test(key));
      if (extraKeys.length > 0) throw new TypeError(`${path} contains non-index array properties`);
      return `[${value.map((item, index) => serialize(item, `${path}[${index}]`, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const enumerableSymbols = Object.getOwnPropertySymbols(value).filter((symbol) =>
      Object.prototype.propertyIsEnumerable.call(value, symbol),
    );
    if (enumerableSymbols.length > 0) throw new TypeError(`${path} contains symbol properties`);

    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key, `${path} key`);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError(`${path}.${key} must not be an accessor property`);
        }
        return `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJcs(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

export function canonicalizeJcsBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJcs(value), "utf8");
}
