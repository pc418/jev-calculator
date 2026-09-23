// Bot protection helpers for worker/index.ts (the entry module may export only its handler).
// Flow: the page solves one Turnstile challenge, POST /api/pass trades the token (single-use,
// 300 s) for an HMAC-signed pass valid PASS_TTL_S, and every POST /api/next carries the pass.
// Pass wire format: base64url(String(exp)) "." base64url(HMAC-SHA256(PASS_SECRET, String(exp))),
// exp in unix seconds. Stateless: no replay list — a pass is a bearer credential until it expires.
import { PASS_TTL_S } from "../shared/protocol";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SITEVERIFY_TIMEOUT_MS = 10_000;
/** The widget must be rendered with `action: "solve"`; siteverify echoes it back. */
export const TURNSTILE_ACTION = "solve";
/** Turnstile tokens are at most 2048 chars. */
export const MAX_TOKEN = 2048;
/**
 * Dev escape hatch: Cloudflare's test sitekeys (1x00000000000000000000AA, …) pair with test
 * secrets whose siteverify reply carries no `action` (observed 2026-09-22: `{success:true,
 * hostname:"example.com", "error-codes":[], metadata:{result_with_testing_key:true}}`), so the
 * action check is skipped for a sitekey with this prefix. Inert in prod, where the sitekey is real.
 */
export const TEST_SITEKEY_PREFIX = "1x0000";

export interface TurnstileEnv {
  TURNSTILE_SITEKEY: string;
  /** Comma-separated frontend hostnames siteverify must report; empty rejects every token. */
  TURNSTILE_HOSTNAMES: string;
  TURNSTILE_SECRET?: string;
  PASS_SECRET?: string;
}

/**
 * enabled: sitekey and both secrets set. disabled: no sitekey (no widget, no pass needed).
 * misconfigured: sitekey set but a secret missing — callers fail closed.
 */
export type Verification = "enabled" | "disabled" | "misconfigured";

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

export function verificationMode(env: TurnstileEnv): Verification {
  if (!nonEmpty(env.TURNSTILE_SITEKEY)) return "disabled";
  return nonEmpty(env.TURNSTILE_SECRET) && nonEmpty(env.PASS_SECRET) ? "enabled" : "misconfigured";
}

// --- pass -------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null on anything that is not unpadded base64url. */
function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Mints a pass expiring at nowS + PASS_TTL_S. Throws when PASS_SECRET is empty. */
export async function mintPass(env: Pick<TurnstileEnv, "PASS_SECRET">, nowS: number): Promise<string> {
  if (!nonEmpty(env.PASS_SECRET)) throw new Error("PASS_SECRET is not set");
  const payload = encoder.encode(String(nowS + PASS_TTL_S));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.PASS_SECRET), payload);
  return `${toBase64url(payload)}.${toBase64url(new Uint8Array(sig))}`;
}

/** True iff the signature verifies (constant-time, crypto.subtle.verify) and exp > nowS. Malformed → false. */
export async function verifyPass(env: Pick<TurnstileEnv, "PASS_SECRET">, pass: string, nowS: number): Promise<boolean> {
  if (!nonEmpty(env.PASS_SECRET)) return false;
  const parts = pass.split(".");
  if (parts.length !== 2) return false;
  const payload = fromBase64url(parts[0]!);
  const sig = fromBase64url(parts[1]!);
  if (payload === null || sig === null) return false;
  const exp = new TextDecoder().decode(payload);
  if (!/^\d{1,12}$/.test(exp)) return false;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.PASS_SECRET), sig, payload);
    return ok && Number(exp) > nowS;
  } catch {
    return false;
  }
}

// --- siteverify -------------------------------------------------------------------------------

/** Logged by /api/pass. Never log the token, the secret or the pass. */
export type SiteverifyReason = "ok" | "siteverify_failed" | "bad_action" | "bad_hostname" | "network";

export function allowedHostnames(list: string): string[] {
  return list
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
}

/**
 * Validates a Turnstile token with siteverify. Fails closed: network error or timeout → "network";
 * non-2xx, non-JSON or success !== true → "siteverify_failed"; then action, then hostname.
 */
export async function siteverify(env: TurnstileEnv, token: string, remoteip: string | null): Promise<SiteverifyReason> {
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET ?? "", response: token });
  if (remoteip !== null && remoteip !== "") form.set("remoteip", remoteip);
  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch {
    return "network";
  }
  if (!res.ok) return "siteverify_failed";
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return "siteverify_failed";
  }
  if (typeof body !== "object" || body === null) return "siteverify_failed";
  const { success, action, hostname } = body as Record<string, unknown>;
  if (success !== true) return "siteverify_failed";
  if (!env.TURNSTILE_SITEKEY.startsWith(TEST_SITEKEY_PREFIX) && action !== TURNSTILE_ACTION) return "bad_action";
  const allowed = allowedHostnames(env.TURNSTILE_HOSTNAMES);
  if (typeof hostname !== "string" || !allowed.includes(hostname.toLowerCase())) return "bad_hostname";
  return "ok";
}
