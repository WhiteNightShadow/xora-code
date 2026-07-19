import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeJcs } from "../jcs.js";

describe("RFC 8785 JCS", () => {
  it("uses ECMAScript number serialization and UTF-16 property ordering", () => {
    const value = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0],
      literals: [null, true, false],
      string: "€$\u000f\nA'B\"\\\"/",
    };
    assert.equal(
      canonicalizeJcs(value),
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
    assert.equal(canonicalizeJcs({ z: 1, a: 2 }), '{"a":2,"z":1}');
  });

  it("rejects values outside the I-JSON data model", () => {
    assert.throws(() => canonicalizeJcs(Number.NaN), /non-finite/);
    assert.throws(() => canonicalizeJcs("\ud800"), /unpaired/);
    const sparse = new Array(2);
    sparse[1] = true;
    assert.throws(() => canonicalizeJcs(sparse), /sparse/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(() => canonicalizeJcs(cycle), /cycle/);
  });
});
