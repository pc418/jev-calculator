import { describe, expect, it } from "vitest";
import { formatSci, runScore } from "../src/score";

// PIN: owner 2026-09-22 (night) — the confidence sparkline is replaced by a run score: every step's confidence
// multiplied ("all confidence multiplied as final score (of confidence)"), END step included, shown in scientific
// notation; docs/260922-feat-batch-revert-withhold-ui.md
describe("runScore", () => {
  it("is null for a run with no steps", () => {
    expect(runScore([])).toBeNull();
  });

  it("multiplies the confidence of every step, the END step included", () => {
    expect(runScore([{ confidence: 0.5 }])).toBe(0.5);
    expect(runScore([{ confidence: 0.9 }, { confidence: 0.5 }, { confidence: 0.4 }])).toBeCloseTo(0.18, 12);
    // Dropping the last (END) step would give 0.45, not 0.18.
    expect(runScore([{ confidence: 0.9 }, { confidence: 0.5 }, { confidence: 0.4 }])).not.toBeCloseTo(0.45, 6);
    expect(runScore([{ confidence: 1 }, { confidence: 0 }, { confidence: 0.7 }])).toBe(0);
  });
});

describe("formatSci", () => {
  it.each<[number, string]>([
    [0.45, "4.5 × 10⁻¹"],
    [0.000321, "3.2 × 10⁻⁴"],
    [1, "1.0 × 10⁰"],
    [0.95, "9.5 × 10⁻¹"],
    [0.18, "1.8 × 10⁻¹"],
    [1.2e-12, "1.2 × 10⁻¹²"],
    [0, "0"],
  ])("%s → %s", (x, s) => {
    expect(formatSci(x)).toBe(s);
  });

  it("renders non-finite values as an en dash", () => {
    for (const x of [NaN, Infinity, -Infinity]) expect(formatSci(x)).toBe("–");
  });

  it("uses U+00D7 with plain spaces and only superscript characters in the exponent", () => {
    const s = formatSci(0.0123);
    expect(s).toBe("1.2 × 10⁻²");
    expect(s).toContain(" × ");
    expect(s).toMatch(/^\d\.\d × 10[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+$/);
  });
});
