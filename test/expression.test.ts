import { describe, expect, it } from "vitest";
import {
  MAX_NUMBER_DIGITS,
  isComplete,
  press,
  pressAfterRun,
  toDisplay,
  toWire,
  type Expression,
  type Key,
} from "../shared/expression";
import { MAX_EXPRESSION, WIRE_EXPRESSION_RE, isValidWireExpression } from "../shared/protocol";

/** Presses every key in order; fails the test if any key is refused. */
function type(keys: readonly Key[], from: Expression = []): Expression {
  let e = from;
  for (const k of keys) {
    const next = press(e, k);
    if (next === null) throw new Error(`key ${JSON.stringify(k)} refused after ${JSON.stringify(toWire(e))}`);
    e = next;
  }
  return e;
}

const keys = (s: string): Key[] => s.split(" ").filter(Boolean) as Key[];
const digits = (s: string): Key[] => s.split("") as Key[];

describe("press → display / wire", () => {
  it.each<[string, string, string]>([
    ["1 2 + 3", "12 + 3", "12 + 3"],
    ["3 4 7 * 2 9", "347 × 29", "347 * 29"],
    ["1 0 / 4", "10 ÷ 4", "10 / 4"],
    ["3 - 5", "3 − 5", "3 - 5"],
    ["sqrt 1 4 4", "√144", "sqrt(144)"],
    ["sqrt 1 4 4 + 3", "√144 + 3", "sqrt(144) + 3"],
    ["2 + sqrt 2", "2 + √2", "2 + sqrt(2)"],
    ["1 7 mod 5", "17 mod 5", "17 mod 5"],
    ["1 . 5 * 2 . 2 5", "1.5 × 2.25", "1.5 * 2.25"],
    ["0 . 5", "0.5", "0.5"],
    ["1 / 0", "1 ÷ 0", "1 / 0"], // division by zero stays allowed (§3.1)
    ["0 0 7", "007", "007"],
  ])("%s", (seq, display, wire) => {
    const e = type(keys(seq));
    expect(toDisplay(e)).toBe(display);
    expect(toWire(e)).toBe(wire);
    expect(isComplete(e)).toBe(true);
  });

  it("renders incomplete expressions without throwing", () => {
    expect(toDisplay(type(keys("1 2 +")))).toBe("12 +");
    expect(toWire(type(keys("1 2 *")))).toBe("12 *");
    expect(toDisplay(type(keys("sqrt")))).toBe("√");
    expect(toDisplay(type(keys("1 .")))).toBe("1.");
    expect(toDisplay([])).toBe("");
    expect(toWire([])).toBe("");
  });
});

describe("isComplete (= gating)", () => {
  it.each(["", "1 +", "sqrt", "1 + sqrt", "1 .", "7 mod", "7 mod 0", "7 mod 0 0"])("false for %j", (seq) => {
    expect(isComplete(type(keys(seq)))).toBe(false);
  });
  it.each(["1", "1 . 5", "7 mod 0 1", "7 mod 1 0", "sqrt 0", "0 mod 3"])("true for %j", (seq) => {
    expect(isComplete(type(keys(seq)))).toBe(true);
  });
});

describe("press refuses disallowed keys", () => {
  it.each<[string, Key]>([
    ["", "+"], // op at start
    ["", "mod"],
    ["", "."], // leading dot
    ["1 +", "."], // leading dot after op
    ["1 . 5", "."], // two dots
    ["1 .", "."],
    ["1 .", "+"], // trailing dot before an op
    ["1 +", "*"], // op after op
    ["1 +", "mod"],
    ["sqrt", "sqrt"], // sqrt after sqrt
    ["sqrt", "+"],
    ["1", "sqrt"], // sqrt after a number
    ["7 mod", "."], // "." right after mod
    ["7 mod 3", "."], // mod divisor is an integer literal
    ["7 mod", "sqrt"], // no sqrt on a mod operand
    ["2 . 5", "mod"], // mod dividend is an integer literal
    ["sqrt 4", "mod"],
    ["7 mod 0", "+"], // a zero divisor must be fixed first
    ["7 mod 0 0", "mod"],
    ["", "back"],
    ["", "clear"],
  ])("after %j refuses %j", (seq, key) => {
    expect(press(type(keys(seq)), key)).toBeNull();
  });
});

describe("back / clear", () => {
  it("back removes one character from a number, then one token", () => {
    let e = type(keys("sqrt 1 4 4 + 1 2 ."));
    const seen: string[] = [];
    for (;;) {
      const next = press(e, "back");
      if (next === null) break;
      e = next;
      seen.push(toDisplay(e));
    }
    expect(seen).toEqual(["√144 + 12", "√144 + 1", "√144 +", "√144", "√14", "√1", "√", ""]);
  });

  it("clear empties", () => {
    expect(press(type(keys("1 2 + 3")), "clear")).toEqual([]);
  });

  it("press never mutates its input", () => {
    const e = type(keys("1 2"));
    const snapshot = JSON.stringify(e);
    press(e, "3");
    press(e, "back");
    press(e, "+");
    expect(JSON.stringify(e)).toBe(snapshot);
  });
});

describe("number and length caps", () => {
  // PIN: owner 2026-09-22 (evening, "given its perf") — 8-digit operands (was 12), docs/260922-plan-jev-calculator.md §3.1; answer cap is 12 chars since that night (test/runner.test.ts)
  it("accepts the 8th digit and refuses the 9th; the dot does not count", () => {
    expect(MAX_NUMBER_DIGITS).toBe(8);
    const twelve = type(digits("12345678"));
    expect(toWire(twelve)).toBe("12345678");
    expect(press(twelve, "3")).toBeNull();

    const dec = type(digits("1234.5678"));
    expect(toWire(dec)).toBe("1234.5678");
    expect(isComplete(dec)).toBe(true);
    expect(press(dec, "3")).toBeNull();

    // the cap is per number: the next operand starts fresh
    expect(toWire(type(["+", ...digits("12345678")], twelve))).toBe("12345678 + 12345678");
  });

  it("refuses growth past MAX_EXPRESSION on the wire string, and never strands an uncompletable state", () => {
    // "12345678 + " × 7 = 11*7 = 77 > 64, so the cap bites mid-way.
    let e: Expression = [];
    const seq: Key[] = [];
    for (let i = 0; i < 7; i++) seq.push(...digits("12345678"), "+");
    let refused: Key | undefined;
    for (const k of seq) {
      const next = press(e, k);
      if (next === null) {
        refused = k;
        break;
      }
      e = next;
    }
    expect(refused).toBeDefined();
    expect(toWire(e).length).toBeLessThanOrEqual(MAX_EXPRESSION);
    // Whatever state the cap left us in can still be completed with one digit (or already is).
    const done = isComplete(e) ? e : press(e, "1");
    expect(done).not.toBeNull();
    expect(isComplete(done!)).toBe(true);
    expect(toWire(done!).length).toBeLessThanOrEqual(MAX_EXPRESSION);
  });

  it("allows back after the cap", () => {
    const e = type([...digits("12345678"), "+", ...digits("1")]);
    expect(press(e, "back")).not.toBeNull();
  });
});

describe("property: every reachable complete expression is valid on the wire", () => {
  const ALL: Key[] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "*", "/", "mod", "sqrt", "back", "clear"];

  // Deterministic PRNG (mulberry32) so failures reproduce.
  function rng(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("random walks over 2000 sequences", () => {
    const r = rng(20260922);
    let completes = 0;
    let withMod = 0;
    let withSqrt = 0;
    for (let run = 0; run < 2000; run++) {
      let e: Expression = [];
      const len = 1 + Math.floor(r() * 60);
      for (let i = 0; i < len; i++) {
        // Bias away from back/clear so long expressions happen.
        const k = ALL[Math.floor(r() * (r() < 0.9 ? ALL.length - 2 : ALL.length))]!;
        const next = press(e, k);
        if (next === null) continue;
        e = next;
        const wire = toWire(e);
        expect(wire.length).toBeLessThanOrEqual(MAX_EXPRESSION);
        expect(toDisplay(e)).not.toMatch(/[*/]|sqrt/);
        expect(wire).not.toMatch(/[×÷−√]/);
        if (isComplete(e)) {
          completes++;
          if (wire.includes("mod")) withMod++;
          if (wire.includes("sqrt")) withSqrt++;
          expect(WIRE_EXPRESSION_RE.test(wire), wire).toBe(true);
          expect(isValidWireExpression(wire), wire).toBe(true);
          expect(wire.length).toBeLessThanOrEqual(MAX_EXPRESSION);
        }
      }
    }
    // The walk must actually exercise the interesting shapes.
    expect(completes).toBeGreaterThan(5000);
    expect(withMod).toBeGreaterThan(100);
    expect(withSqrt).toBeGreaterThan(100);
  });
});

// PIN: owner 2026-09-22 (night) — "After computed, another press at num will Clear first instead of append":
// after a finished run a digit / "." / sqrt starts a new expression, an operator/back/clear edits the old one;
// docs/260922-feat-batch-revert-withhold-ui.md
describe("pressAfterRun", () => {
  const finished = type(keys("4 + 9"));

  it("a digit starts a fresh expression instead of appending", () => {
    const next = pressAfterRun(finished, "1");
    expect(next).not.toBeNull();
    expect(toDisplay(next!)).toBe("1");
    expect(next).toEqual(press([], "1"));
    expect(press(finished, "1")).not.toEqual(next); // plain press would append → "4 + 91"
  });

  it("a digit is accepted even when the finished expression is at the digit cap", () => {
    const full = type(digits("1".repeat(MAX_NUMBER_DIGITS)));
    expect(press(full, "7")).toBeNull();
    expect(toDisplay(pressAfterRun(full, "7")!)).toBe("7");
  });

  it("'.' and sqrt behave as on an empty keypad", () => {
    expect(pressAfterRun(finished, ".")).toEqual(press([], "."));
    expect(pressAfterRun(finished, "sqrt")).toEqual(press([], "sqrt"));
    expect(toDisplay(pressAfterRun(finished, "sqrt")!)).toBe("√");
  });

  it("operators, back and clear edit the finished expression as usual", () => {
    for (const k of ["+", "-", "*", "/", "mod", "back"] as const) expect(pressAfterRun(finished, k)).toEqual(press(finished, k));
    expect(toDisplay(pressAfterRun(finished, "+")!)).toBe("4 + 9 +");
    expect(toDisplay(pressAfterRun(finished, "back")!)).toBe("4 +");
    expect(pressAfterRun(finished, "clear")).toEqual([]);
  });
});
