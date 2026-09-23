// Run score: the product of every step's Jev confidence, shown in scientific notation.
// Owner 2026-09-22 (night): "all confidence multiplied as final score (of confidence)". Pure; unit-tested.

/** Product of `confidence` over all steps (the END step included); null for zero steps. */
export function runScore(steps: readonly { confidence: number }[]): number | null {
  if (steps.length === 0) return null;
  return steps.reduce((acc, s) => acc * s.confidence, 1);
}

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

/** 2 significant digits, Unicode superscript exponent: 0.45 → "4.5 × 10⁻¹", 1 → "1.0 × 10⁰", 0 → "0", non-finite → "–". */
export function formatSci(x: number): string {
  if (!Number.isFinite(x)) return "–";
  if (x === 0) return "0";
  const [mantissa, exp] = x.toExponential(1).split("e") as [string, string];
  const e = String(Number(exp)); // "+0" → "0", "-4" → "-4"
  return `${mantissa} × 10${[...e].map((c) => SUPERSCRIPT[c] ?? c).join("")}`;
}
