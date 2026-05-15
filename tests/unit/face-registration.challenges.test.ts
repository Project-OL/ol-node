import { describe, expect, it } from "vitest";
import {
  buildRandomChallengeSequence,
  shuffleChallengeTypes,
} from "../../src/services/face-registration/face-registration.challenges";

describe("face-registration challenges", () => {
  it("shuffle is deterministic with fixed rng", () => {
    const rng = () => 0.99;
    const s = shuffleChallengeTypes(["a", "b", "c", "d"], rng);
    expect(s).toHaveLength(4);
    expect(new Set(s).size).toBe(4);
  });

  it("buildRandomChallengeSequence returns 2-3 ordered steps", () => {
    const rng = () => 0.1;
    const seq = buildRandomChallengeSequence({ rng });
    expect(seq.length).toBeGreaterThanOrEqual(2);
    expect(seq.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < seq.length; i += 1) {
      expect(seq[i]!.order).toBe(i + 1);
    }
  });
});
