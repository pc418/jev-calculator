// Wire contract between the page and the Worker. Imported by both sides; the grammar lives once.
// Design: docs/260922-plan-jev-calculator.md §3.2, §4.

export const OPTIONS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-", "END"] as const;
export type Option = (typeof OPTIONS)[number];

export const MAX_PREFIX = 24;
export const MAX_EXPRESSION = 64;
export const MAX_BODY = 1024;

/** Emitted answer so far. Alphabet-bounded on purpose: Jev's malformed output must survive (§3.2). */
export const PREFIX_RE = /^[0-9.-]{0,24}$/;

/**
 * Wire expression grammar (§3.1): term (" " op " " term)*, term = "sqrt(" number ")" | number.
 * No length bound and no `mod` operand rules here: use isValidWireExpression for the full check.
 */
/** Owner 2026-09-22: ≤ 12 digits per operand (the dot excluded). Mirrors MAX_NUMBER_DIGITS in shared/expression.ts. */
export const MAX_OPERAND_DIGITS = 12;
const NUM = String.raw`(?=\d{1,12}(?:\.\d{1,12})?(?![\d.]))(?=(?:\d\.?){1,12}(?![\d.]))\d+(?:\.\d+)?`;
const TERM = String.raw`(?:sqrt\(${NUM}\)|${NUM})`;
export const WIRE_EXPRESSION_RE = new RegExp(String.raw`^${TERM}(?: (?:\+|-|\*|\/|mod) ${TERM})*$`);

/**
 * Full check of a wire expression: length cap, WIRE_EXPRESSION_RE, and the `mod` domain (§3.1):
 * both operands plain integer literals (no ".", no sqrt), divisor not zero. The keypad
 * (`isComplete` in shared/expression.ts) and the Worker both use this, so the domain lives once.
 */
export function isValidWireExpression(wire: string): boolean {
  if (wire.length > MAX_EXPRESSION || !WIRE_EXPRESSION_RE.test(wire)) return false;
  const parts = wire.split(" "); // term op term op term … (the regex guarantees single spaces)
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] !== "mod") continue;
    const left = parts[i - 1] ?? "";
    const right = parts[i + 1] ?? "";
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right) || /^0+$/.test(right)) return false;
  }
  return true;
}

export interface NextRequest {
  expression: string; // wire string
  prefix: string; // answer so far, PREFIX_RE
}

/** Which upstream answered: the Vercel AI Gateway (first choice) or the direct TypeSafe API (fallback). */
export type UpstreamRoute = "gateway" | "direct";

export interface NextResponse {
  choice: Option;
  confidence: number;
  probabilities: Record<Option, number>;
  /** Options not offered to Jev this step (shared/withhold.ts); their `probabilities` are 0. Usually []. */
  withheld: Option[];
  upstream_ms: number;
  usage: { input_tokens: number; output_tokens: number };
  cost: string;
  market_cost: string;
  generation_id: string;
  route: UpstreamRoute;
  /** As echoed by the upstream: the gateway echoes the id sent, the direct API the served version (e.g. "jev-1.13.0"); "" if absent. */
  model: string;
}

export type NextErrorCode =
  | "bad_json"
  | "body_too_large"
  | "invalid_expression"
  | "invalid_prefix"
  | "bad_origin"
  | "rate_limited"
  | "upstream"
  | "disabled"
  | "unverified"; // /api/next: missing/invalid/expired pass (401); /api/pass: Turnstile rejected (403)

export interface NextError {
  error: NextErrorCode;
  retry_after_s?: number; // rate_limited
  status?: number; // upstream
}

// Bot protection (Cloudflare Turnstile). The page solves one challenge, trades the token at
// POST /api/pass for a short-lived HMAC-signed pass, and sends the pass on every /api/next call.

/** Request header carrying the pass on POST /api/next. */
export const PASS_HEADER = "X-Jev-Pass";
/** Pass lifetime in seconds. */
export const PASS_TTL_S = 1800;

/** GET /api/config. `turnstile_sitekey: null` means verification is disabled (no widget, no pass). */
export interface ConfigResponse {
  turnstile_sitekey: string | null;
}

/** POST /api/pass body: the Turnstile token (1..2048 chars). */
export interface PassRequest {
  token: string;
}

export interface PassResponse {
  pass: string;
  expires_in: number; // seconds (PASS_TTL_S)
}
