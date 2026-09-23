// Which options Jev is NOT offered on a step. Imported by both sides (Worker request/response, page pills).
// PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before
// the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
// Digit counting only: the answer is never evaluated here (the repo deliberately computes no result).
import { OPTIONS, type Option } from "./protocol";

/** A pure product of non-negative integer literals in wire form, e.g. "123 * 45", "12 * 3 * 4". */
const PRODUCT_RE = /^\d+( \* \d+)+$/;

/**
 * Minimum digit count of the product `wire` denotes, or null when `wire` is not a pure integer product.
 * Any zero operand → 1 ("0"). Otherwise Σ digits − (n − 1): an m-digit times an n-digit positive
 * integer has at least m + n − 1 digits. Leading zeros do not count ("007" is 1 digit).
 */
export function minProductDigits(wire: string): number | null {
  if (!PRODUCT_RE.test(wire)) return null;
  const digits = wire.split(" * ").map((operand) => operand.replace(/^0+/, "").length);
  if (digits.includes(0)) return 1;
  return digits.reduce((sum, d) => sum + d, 0) - (digits.length - 1);
}

/** ["END"] while the answer so far (its [0-9] characters only) is shorter than a product can be; else []. */
export function withheldOptions(wire: string, prefix: string): readonly Option[] {
  const min = minProductDigits(wire);
  if (min === null) return [];
  const emitted = prefix.replace(/[^0-9]/g, "").length;
  return emitted < min ? ["END"] : [];
}

/** OPTIONS minus the withheld ones, in OPTIONS order. */
export function offeredOptions(wire: string, prefix: string): readonly Option[] {
  const withheld = withheldOptions(wire, prefix);
  return OPTIONS.filter((o) => !withheld.includes(o));
}
