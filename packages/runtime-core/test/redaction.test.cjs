const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { SecretRedactor } = require("../dist/index.js");

describe("SecretRedactor", () => {
  it("redacts registered values, token shapes, URL credentials, and sensitive keys", () => {
    const redactor = new SecretRedactor({ knownSecrets: ["known-private-value"] });
    const input = {
      authorization: "Bearer xai-super-secret-token",
      nested: {
        text: "known-private-value and sk-1234567890abcdef",
        url: "https://alice:password@example.com/?api_key=secret-value",
      },
    };
    const output = redactor.redactValue(input);
    assert.equal(output.authorization, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(output), /known-private-value|1234567890abcdef|password|secret-value/);
    assert.equal(input.nested.text, "known-private-value and sk-1234567890abcdef");
  });

  it("handles cycles without mutating its input", () => {
    const input = { value: "safe" };
    input.self = input;
    const output = new SecretRedactor().redactValue(input);
    assert.equal(output.self, "[Circular]");
    assert.equal(input.self, input);
  });
});
