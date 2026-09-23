// PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
import { describe, expect, it } from "vitest";
import { OPTIONS } from "../shared/protocol";
import { minProductDigits, offeredOptions, withheldOptions } from "../shared/withhold";

describe("minProductDigits", () => {
  it.each([
    ["123 * 45", 4],
    ["12 * 12", 3],
    ["0 * 5", 1],
    ["007 * 5", 1],
    ["000 * 123456", 1],
    ["12 * 3 * 4", 2],
    ["99999999 * 99999999", 15], // both operands at the 8-digit cap: 15 ≤ MAX_PREFIX 16, so END can be offered
    ["100 * 10", 4], // the bound is tight: 1000
    ["5 * 0", 1],
  ])("%j → %i", (wire, min) => {
    expect(minProductDigits(wire)).toBe(min);
  });

  it.each(["12 + 3", "1.5 * 2", "sqrt(4) * 2", "12 * 3 + 1", "17 mod 5", "12", "12 / 3", "12 - 3", "12*3", "12 * 3 "])(
    "%j → null (not a pure integer product)",
    (wire) => {
      expect(minProductDigits(wire)).toBeNull();
    },
  );
});

describe("withheldOptions", () => {
  it.each([
    ["123 * 45", "", ["END"]],
    ["123 * 45", "555", ["END"]],
    ["123 * 45", "5555", []],
    ["123 * 45", "55555", []],
    ["123 * 45", "-5.55", ["END"]], // only [0-9] count: 3 digits
    ["123 * 45", "-55.55", []], // 4 digits
    ["0 * 5", "", ["END"]],
    ["0 * 5", "0", []],
    ["12 + 3", "", []],
    ["1.5 * 2", "", []],
  ] as const)("(%j, %j) → %j", (wire, prefix, expected) => {
    expect(withheldOptions(wire, prefix)).toEqual(expected);
  });
});

describe("offeredOptions", () => {
  it("drops only END, keeping OPTIONS order, while withheld", () => {
    expect(offeredOptions("123 * 45", "12")).toEqual(OPTIONS.filter((o) => o !== "END"));
    expect(offeredOptions("123 * 45", "12")).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-"]);
  });
  it("is all 13 in OPTIONS order otherwise", () => {
    expect(offeredOptions("123 * 45", "5535")).toEqual([...OPTIONS]);
    expect(offeredOptions("12 + 3", "")).toEqual([...OPTIONS]);
  });
});
