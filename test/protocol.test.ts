import { describe, expect, it } from "vitest";
import {
  MAX_EXPRESSION,
  MAX_PREFIX,
  OPTIONS,
  PREFIX_RE,
  WIRE_EXPRESSION_RE,
  isValidWireExpression,
} from "../shared/protocol";

describe("OPTIONS", () => {
  it("is the fixed 13-option order 0-9 . - END", () => {
    expect(OPTIONS).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-", "END"]);
  });
});

describe("WIRE_EXPRESSION_RE", () => {
  it.each([
    "12 + 3",
    "sqrt(144) + 3",
    "sqrt(2)",
    "347 * 29",
    "10 / 4",
    "3 - 5",
    "17 mod 5",
    "1.5 * 2.25",
    "10 / 0",
    "1 + 2 - 3 * 4 / 5 mod 6",
  ])("accepts %j", (s) => {
    expect(WIRE_EXPRESSION_RE.test(s)).toBe(true);
    expect(isValidWireExpression(s)).toBe(true);
  });

  it.each([
    "",
    "12 +",
    "12 + ",
    "+ 3",
    "sqrt()",
    "sqrt(-1)",
    "1..2",
    "1.",
    ".5",
    "12+3",
    "12  + 3",
    "12 + 3 =",
    "-3",
    "3 × 5",
    "√144",
    "1e5",
    "sqrt(sqrt(16))",
    "(1 + 2)",
    "12 + 3\n",
  ])("rejects %j", (s) => {
    expect(WIRE_EXPRESSION_RE.test(s)).toBe(false);
    expect(isValidWireExpression(s)).toBe(false);
  });

  it("rejects 65 chars, accepts 64 (length checked by isValidWireExpression)", () => {
    // 12-digit operands joined by " + " : 4 terms = 48 digits + 9 = 57, then "+ 1234" → 64 chars
    const at64 = ["111111111111", "222222222222", "333333333333", "444444444444"].join(" + ") + " + 1234";
    expect(at64).toHaveLength(64);
    expect(isValidWireExpression(at64)).toBe(true);
    const at65 = at64 + "5";
    expect(WIRE_EXPRESSION_RE.test(at65)).toBe(true); // the regex alone has no total-length bound
    expect(isValidWireExpression(at65)).toBe(false);
  });

  // PIN: owner 2026-09-22 — 12-digit operands are enforced server-side too (docs/260922-plan-jev-calculator.md §3.1);
  // Codex review 2026-09-22 flagged the keypad/regex drift that let a scripted client send a 60-digit operand.
  it.each(["123456789012", "123456.789012", "sqrt(123456789012)", "1.23456789012"])("accepts a 12-digit operand %j", (s) => {
    expect(WIRE_EXPRESSION_RE.test(s)).toBe(true);
  });
  it.each(["1234567890123", "1234567.890123", "sqrt(1234567890123)", "1 + 1234567890123"])("rejects a 13-digit operand %j", (s) => {
    expect(WIRE_EXPRESSION_RE.test(s)).toBe(false);
    expect(isValidWireExpression(s)).toBe(false);
  });
});

describe("isValidWireExpression mod domain", () => {
  it.each(["17 mod 5", "7 mod 01", "0 mod 3", "1 + 7 mod 3", "7 mod 3 mod 2"])("accepts %j", (s) => {
    expect(isValidWireExpression(s)).toBe(true);
  });
  it.each(["2.5 mod 3", "7 mod 2.5", "7 mod 0", "7 mod 00", "sqrt(4) mod 3", "7 mod sqrt(4)", "7 mod 0 + 1"])(
    "rejects %j (regex alone accepts it)",
    (s) => {
      expect(WIRE_EXPRESSION_RE.test(s)).toBe(true);
      expect(isValidWireExpression(s)).toBe(false);
    },
  );
});

describe("PREFIX_RE", () => {
  // Alphabet-bounded by design (§3.2): Jev's malformed output must survive.
  it.each(["", "-1.5", "1-", "--", "1.2.3", "007", "0123456789.-0123", "-".repeat(MAX_PREFIX)])("accepts %j", (s) => {
    expect(PREFIX_RE.test(s)).toBe(true);
  });
  it.each(["1e5", "1".repeat(MAX_PREFIX + 1), "END", " 1", "1 ", "+1", "1,5", "1\n"])("rejects %j", (s) => {
    expect(PREFIX_RE.test(s)).toBe(false);
  });
});
