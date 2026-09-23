// Keypad token model + serialisation. NO evaluation anywhere in this repo.
// Design: docs/260922-plan-jev-calculator.md §3.1. Implemented by the logic worker; UI calls only this API.
import { MAX_EXPRESSION, isValidWireExpression } from "./protocol";

export type Key =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "." | "+" | "-" | "*" | "/" | "mod" | "sqrt" | "back" | "clear";

/** Opaque to the UI. */
export type Token =
  | { kind: "num"; text: string } // digits with at most one "."
  | { kind: "op"; op: "+" | "-" | "*" | "/" | "mod" }
  | { kind: "sqrt" };

export type Expression = readonly Token[];

/** Owner 2026-09-22 (evening): at most 8 digits per number (both sides of the dot; the dot does not count). */
export const MAX_NUMBER_DIGITS = 8;

type Op = Extract<Token, { kind: "op" }>["op"];
const OPS: readonly string[] = ["+", "-", "*", "/", "mod"];
const DISPLAY_OP: Record<Op, string> = { "+": "+", "-": "−", "*": "×", "/": "÷", mod: "mod" };

const isDigit = (key: Key): boolean => key.length === 1 && key >= "0" && key <= "9";

/** The op token right before the term that ends at `numIndex` (skipping a sqrt), if any. */
function opBefore(expr: Expression, numIndex: number): Op | undefined {
  let i = numIndex - 1;
  if (expr[i]?.kind === "sqrt") i -= 1;
  const t = expr[i];
  return t?.kind === "op" ? t.op : undefined;
}

/**
 * Wire length of the shortest complete expression reachable by appending keys: trailing op or
 * sqrt still needs one digit, a trailing "." needs one digit. Used for the length cap so the
 * keypad never enters a state that cannot be completed within MAX_EXPRESSION.
 */
function minCompleteWireLength(expr: Expression): number {
  const last = expr[expr.length - 1];
  const wire = toWire(expr);
  if (last === undefined) return 0;
  if (last.kind === "op") return wire.length + 2; // " " + digit
  if (last.kind === "sqrt") return wire.length + 1; // "sqrt()" + digit
  return last.text.endsWith(".") ? wire.length + 1 : wire.length;
}

function pressRaw(expr: Expression, key: Key): Expression | null {
  const n = expr.length;
  const last = expr[n - 1];

  if (key === "clear") return n === 0 ? null : [];

  if (key === "back") {
    if (last === undefined) return null;
    if (last.kind === "num" && last.text.length > 1) {
      return [...expr.slice(0, -1), { kind: "num", text: last.text.slice(0, -1) }];
    }
    return expr.slice(0, -1);
  }

  if (isDigit(key)) {
    if (last?.kind === "num") {
      if (last.text.replace(".", "").length >= MAX_NUMBER_DIGITS) return null;
      return [...expr.slice(0, -1), { kind: "num", text: last.text + key }];
    }
    return [...expr, { kind: "num", text: key }];
  }

  if (key === ".") {
    // No leading dot, one dot per number, and mod operands are integer literals.
    if (last?.kind !== "num" || last.text.includes(".")) return null;
    if (opBefore(expr, n - 1) === "mod") return null;
    return [...expr.slice(0, -1), { kind: "num", text: last.text + "." }];
  }

  if (key === "sqrt") {
    // At the start or right after a non-mod op; never twice, never on a mod operand.
    if (last === undefined) return [{ kind: "sqrt" }];
    if (last.kind === "op" && last.op !== "mod") return [...expr, { kind: "sqrt" }];
    return null;
  }

  if (OPS.includes(key)) {
    const op = key as Op;
    // A binary op needs a finished number on its left.
    if (last?.kind !== "num" || last.text.endsWith(".")) return null;
    const leftOp = opBefore(expr, n - 1);
    // A zero mod divisor must be fixed (more digits or back) before anything follows it.
    if (leftOp === "mod" && /^0+$/.test(last.text)) return null;
    if (op === "mod" && (last.text.includes(".") || expr[n - 2]?.kind === "sqrt")) return null;
    return [...expr, { kind: "op", op }];
  }

  return null;
}

/** Returns the new expression, or null when `key` is not allowed here (UI disables that key). */
export function press(expr: Expression, key: Key): Expression | null {
  const next = pressRaw(expr, key);
  if (next === null) return null;
  // The cap only blocks growth; back/clear always shrink.
  if (key !== "back" && key !== "clear" && minCompleteWireLength(next) > MAX_EXPRESSION) return null;
  return next;
}

/**
 * A key pressed after a finished run. Owner 2026-09-22 (night): "After computed, another press at num will
 * Clear first instead of append" — a key that begins a new number (digit, ".", sqrt) starts a fresh
 * expression; an operator, back or clear edits the finished expression as usual.
 */
export function pressAfterRun(expr: Expression, key: Key): Expression | null {
  const startsNumber = isDigit(key) || key === "." || key === "sqrt";
  return startsNumber ? press([], key) : press(expr, key);
}

/** True when the expression is complete under the grammar (enables "="). */
export function isComplete(expr: Expression): boolean {
  return expr.length > 0 && isValidWireExpression(toWire(expr));
}

function serialise(expr: Expression, op: (o: Op) => string, term: (sqrt: boolean, num: string) => string): string {
  const parts: string[] = [];
  let sqrt = false;
  for (const t of expr) {
    if (t.kind === "sqrt") sqrt = true;
    else if (t.kind === "num") {
      parts.push(term(sqrt, t.text));
      sqrt = false;
    } else parts.push(op(t.op));
  }
  if (sqrt) parts.push(term(true, "")); // trailing sqrt with no number yet (incomplete)
  return parts.join(" ");
}

/** "√144 + 3", "17 mod 5" — what the user sees. */
export function toDisplay(expr: Expression): string {
  return serialise(expr, (o) => DISPLAY_OP[o], (sqrt, num) => (sqrt ? "√" : "") + num);
}

/** "sqrt(144) + 3", "17 mod 5" — what Jev sees. Must satisfy WIRE_EXPRESSION_RE. */
export function toWire(expr: Expression): string {
  return serialise(expr, (o) => o, (sqrt, num) => (sqrt ? `sqrt(${num})` : num));
}
