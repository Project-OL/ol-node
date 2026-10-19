import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScale } from "./index.js";

test("API group: caps and sanity", () => {
  assert.equal(checkScale({ kind: "api", minReplicas: 1, maxReplicas: 3 }), null);
  assert.equal(checkScale({ kind: "api", minReplicas: 4, maxReplicas: 6 }), null);
  assert.match(checkScale({ kind: "api", minReplicas: 0, maxReplicas: 3 }), /at least 1/);
  assert.match(checkScale({ kind: "api", minReplicas: 3, maxReplicas: 2 }), />= minReplicas/);
  assert.match(checkScale({ kind: "api", minReplicas: 5, maxReplicas: 6 }), /capped at 4/);
  assert.match(checkScale({ kind: "api", minReplicas: 1, maxReplicas: 7 }), /capped at 6/);
  assert.match(checkScale({ kind: "api", minReplicas: "1", maxReplicas: 3 }), /integers/);
});

test("Redis: sizes, tier, and the 1.5x downsize guard", () => {
  const cur = { tier: "STANDARD_HA", state: "READY", sizeGb: 4, usedGb: 1.2 };
  assert.equal(checkScale({ kind: "redis", sizeGb: 5 }, cur), null);
  assert.equal(checkScale({ kind: "redis", sizeGb: 2 }, cur), null); // 2 >= 1.2 * 1.5 = 1.8
  assert.match(checkScale({ kind: "redis", sizeGb: 2 }, { ...cur, usedGb: 1.5 }), /under 1.5x/);
  assert.match(checkScale({ kind: "redis", sizeGb: 2 }, { ...cur, usedGb: null }), /unknown/);
  assert.match(checkScale({ kind: "redis", sizeGb: 7 }, cur), /one of/);
  assert.match(checkScale({ kind: "redis", sizeGb: 5 }, { ...cur, tier: "BASIC" }), /Standard/);
  assert.match(checkScale({ kind: "redis", sizeGb: 5 }, { ...cur, state: "UPDATING" }), /not READY/);
  assert.match(checkScale({ kind: "redis", sizeGb: 4 }, cur), /already/);
});

test("unknown kinds are refused", () => {
  assert.match(checkScale({ kind: "main-mig", size: 2 }), /api or redis/);
});
