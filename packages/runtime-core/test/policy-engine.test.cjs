const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PolicyEngine, matchesGlob } = require("../dist/index.js");

describe("PolicyEngine", () => {
  it("uses deny > ask > allow precedence independent of rule order", () => {
    const engine = new PolicyEngine([
      { id: "allow-tests", effect: "allow", match: { commandGlobs: ["npm test*"] } },
      { id: "deny-force", effect: "deny", match: { commandGlobs: ["*--force*"] } },
      { id: "ask-process", effect: "ask", match: { toolKinds: ["process.execute"] } },
    ]);
    const result = engine.evaluate({
      operation: "execute",
      toolKind: "process.execute",
      command: { program: "npm", args: ["test", "--force"] },
    });
    assert.equal(result.decision, "deny");
    assert.deepEqual(result.matchedRuleIds, ["allow-tests", "deny-force", "ask-process"]);
  });

  it("requires every selector in a rule and defaults to ask", () => {
    const engine = new PolicyEngine([
      {
        id: "workspace-write",
        effect: "allow",
        match: { operations: ["write"], workspaceGlobs: ["/repo/**"] },
      },
    ]);
    assert.equal(
      engine.evaluate({ operation: "read" }, { workspaceRoot: "/repo/app" }).decision,
      "ask",
    );
    assert.equal(
      engine.evaluate({ operation: "write" }, { workspaceRoot: "/repo/app" }).decision,
      "allow",
    );
  });

  it("matches portable path globs", () => {
    assert.equal(matchesGlob("src/domain/file.ts", "src/**/*.ts"), true);
    assert.equal(matchesGlob("src/file.ts", "src/**/*.ts"), true);
    assert.equal(matchesGlob("src\\domain\\file.ts", "src/**/*.ts"), true);
    assert.equal(matchesGlob("src/domain/file.js", "src/**/*.ts"), false);
  });

  it("rejects duplicate rule ids", () => {
    assert.throws(
      () =>
        new PolicyEngine([
          { id: "same", effect: "allow", match: {} },
          { id: "same", effect: "deny", match: {} },
        ]),
      /unique/,
    );
  });
});
