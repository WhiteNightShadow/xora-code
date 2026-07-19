const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ProviderProfileValidationError,
  generateManagedGrokToml,
  validateProviderProfile,
} = require("../dist/index.js");

function profile(overrides = {}) {
  return {
    id: "team-grok",
    displayName: "Team Grok",
    provider: "openai-compatible",
    model: "grok-4.5",
    baseUrl: "https://api.example.com/v1/",
    apiBackend: "responses",
    auth: { kind: "api-key", secretRef: "vault://provider/team-grok", envName: "TEAM_GROK_KEY" },
    capabilities: { contextWindow: 1000000, backendSearch: true },
    ...overrides,
  };
}

describe("provider profiles", () => {
  it("normalizes and generates deterministic, secret-free managed TOML", () => {
    const validated = validateProviderProfile(profile());
    assert.equal(validated.baseUrl, "https://api.example.com/v1");
    const toml = generateManagedGrokToml(validated, { setDefault: true });
    assert.match(toml, /\[model\."team-grok"\]/);
    assert.match(toml, /env_key = "TEAM_GROK_KEY"/);
    assert.match(toml, /api_backend = "responses"/);
    assert.match(toml, /\[models\]\ndefault = "team-grok"/);
    assert.doesNotMatch(toml, /vault:\/\//);
  });

  it("allows HTTP only on loopback", () => {
    assert.equal(
      validateProviderProfile(profile({ baseUrl: "http://127.0.0.1:11434/v1" })).baseUrl,
      "http://127.0.0.1:11434/v1",
    );
    assert.throws(
      () => validateProviderProfile(profile({ baseUrl: "http://api.example.com/v1" })),
      ProviderProfileValidationError,
    );
  });

  it("rejects metadata endpoints, URL credentials, and literal secret headers", () => {
    for (const overrides of [
      { baseUrl: "https://169.254.169.254/latest" },
      { baseUrl: "https://user:password@api.example.com/v1" },
      { headers: { Authorization: "Bearer xai-this-is-a-secret" } },
    ]) {
      assert.throws(() => validateProviderProfile(profile(overrides)), ProviderProfileValidationError);
    }
    const templated = validateProviderProfile(
      profile({ headers: { Authorization: "Bearer ${TEAM_GROK_KEY}" } }),
    );
    assert.equal(templated.headers.Authorization, "Bearer ${TEAM_GROK_KEY}");
  });

  it("does not let custom endpoints inherit subscription or undeclared environment credentials", () => {
    assert.throws(
      () =>
        validateProviderProfile(
          profile({ provider: "xai", auth: { kind: "subscription" } }),
        ),
      /official xAI endpoints/,
    );
    assert.throws(
      () => validateProviderProfile(profile({ headers: { Authorization: "Bearer ${OTHER_KEY}" } })),
      /injected API-key environment variable/,
    );
    assert.throws(
      () => validateProviderProfile(profile({ auth: { kind: "none" } })),
      /loopback/,
    );
    assert.equal(
      validateProviderProfile(
        profile({
          provider: "xai",
          baseUrl: "https://api.x.ai/v1",
          auth: { kind: "subscription", accountId: "primary" },
        }),
      ).auth.kind,
      "subscription",
    );
  });
});
