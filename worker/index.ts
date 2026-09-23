// Cloudflare Worker: static assets + POST /api/next, plus Turnstile bot protection
// (GET /api/config, POST /api/pass; helpers in ./pass). Design: docs/260922-plan-jev-calculator.md §4.
// Binding/runtime types (Fetcher, RateLimit, ExportedHandler) come from `wrangler types`
// (worker-configuration.d.ts, gitignored; `npm run types` regenerates it).
import {
  MAX_BODY,
  PASS_HEADER,
  PASS_TTL_S,
  PREFIX_RE,
  isValidWireExpression,
  type ConfigResponse,
  type NextError,
  type NextResponse,
  type PassResponse,
  type UpstreamRoute,
} from "../shared/protocol";
import { JevResponseError, buildRequest, mapResponse } from "./jev";
import { MAX_TOKEN, mintPass, siteverify, verificationMode, verifyPass } from "./pass";

export interface Env {
  ASSETS: Fetcher;
  API_LIMIT: RateLimit;
  /** Global budget for the direct-API fallback, always keyed FALLBACK_KEY. */
  FALLBACK_LIMIT: RateLimit;
  // Route 1: Vercel AI Gateway (free credits, 30 req/min on the key).
  JEV_API_KEY: string;
  JEV_BASE_URL: string;
  JEV_MODEL: string;
  JEV_DISABLED: string;
  // Route 2: direct TypeSafe API. Fallback disabled when the key is absent or empty.
  TYPESAFE_API_KEY?: string;
  TYPESAFE_BASE_URL: string;
  TYPESAFE_MODEL: string;
  // Turnstile bot protection (worker/pass.ts). Enabled iff the sitekey and both secrets are set;
  // sitekey set with a secret missing fails closed (/api/next → 503 disabled).
  TURNSTILE_SITEKEY: string;
  TURNSTILE_HOSTNAMES: string;
  TURNSTILE_SECRET?: string;
  PASS_SECRET?: string;
}

// None of these are exported: workerd only accepts handler exports from the entry module.
const UPSTREAM_TIMEOUT_MS = 15_000;
const FALLBACK_KEY = "direct"; // constant key: FALLBACK_LIMIT is one budget per location, not per visitor
const OWN_LIMIT_RETRY_S = 10;
const UPSTREAM_RETRY_DEFAULT_S = 60;
const TRANSIENT = new Set([502, 503, 529]);
const TIMEOUT_STATUS = 504; // reported in {error:"upstream", status} when both attempts timed out
const NETWORK_STATUS = 0; // … when both attempts failed before any HTTP status
// /api/pass carries a token of up to MAX_TOKEN chars, so its body cap is above MAX_BODY.
const PASS_MAX_BODY = 4096;

type ApiBody =
  | NextError
  | NextResponse
  | ConfigResponse
  | PassResponse
  | { error: "not_found" | "method_not_allowed" };

const nowS = () => Math.floor(Date.now() / 1000);

function json(status: number, body: ApiBody, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function rateLimited(retryAfterS: number): Response {
  return json(429, { error: "rate_limited", retry_after_s: retryAfterS }, { "Retry-After": String(retryAfterS) });
}

/** Reads at most `max` bytes; null when the body is larger (chunked bodies have no Content-Length). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseRetryAfter(value: string | null): number {
  if (value !== null && /^\d+$/.test(value.trim())) {
    const s = Number(value.trim());
    if (s > 0) return s;
  }
  return UPSTREAM_RETRY_DEFAULT_S;
}

type Attempt = { kind: "response"; res: Response; ms: number } | { kind: "thrown"; timeout: boolean };

interface Upstream {
  route: UpstreamRoute;
  baseUrl: string;
  key: string;
  model: string;
}

/** Outcome of one route: its last attempt, how many calls it took, and whether both were transient failures. */
interface RouteResult {
  route: UpstreamRoute;
  attempt: Attempt;
  calls: number;
  transientTwice: boolean;
}

const isTransient = (a: Attempt) => a.kind === "thrown" || TRANSIENT.has(a.res.status);

async function callUpstream(up: Upstream, body: string): Promise<Attempt> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${up.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${up.key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return { kind: "response", res, ms: Date.now() - t0 };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { kind: "thrown", timeout: name === "TimeoutError" || name === "AbortError" };
  }
}

/** One route: a call plus exactly one retry on a transient failure (502/503/529, timeout, network). */
async function callRoute(up: Upstream, expression: string, prefix: string): Promise<RouteResult> {
  const body = JSON.stringify(buildRequest(up.model, expression, prefix));
  const first = await callUpstream(up, body);
  if (!isTransient(first)) return { route: up.route, attempt: first, calls: 1, transientTwice: false };
  const second = await callUpstream(up, body);
  return { route: up.route, attempt: second, calls: 2, transientTwice: isTransient(second) };
}

/** Shared by POST /api/next and /api/pass, in order: kill switch, per-IP limiter, Origin. null = pass. */
async function preBodyGuards(request: Request, env: Env): Promise<Response | null> {
  if (env.JEV_DISABLED === "1") return json(503, { error: "disabled" });

  const { success } = await env.API_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
  if (!success) return rateLimited(OWN_LIMIT_RETRY_S);

  // Same-origin friction, not auth: a present Origin must be ours. Checked before reading the body.
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) return json(403, { error: "bad_origin" });
  return null;
}

/** JSON Content-Type, body capped at `max` bytes, parsed to a plain object; otherwise a 400 Response. */
async function readJsonObject(request: Request, max: number): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return json(400, { error: "bad_json" });

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > max) return json(400, { error: "body_too_large" });
  const text = await readCapped(request, max);
  if (text === null) return json(400, { error: "body_too_large" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { error: "bad_json" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json(400, { error: "bad_json" });
  return parsed as Record<string, unknown>;
}

function handleConfig(env: Env): Response {
  const body: ConfigResponse = {
    turnstile_sitekey: verificationMode(env) === "enabled" ? env.TURNSTILE_SITEKEY : null,
  };
  return json(200, body);
}

/** Only routed while verification is enabled. Trades a Turnstile token for a signed pass. */
async function handlePass(request: Request, env: Env): Promise<Response> {
  const blocked = await preBodyGuards(request, env);
  if (blocked !== null) return blocked;
  const parsed = await readJsonObject(request, PASS_MAX_BODY);
  if (parsed instanceof Response) return parsed;
  const { token } = parsed;
  if (typeof token !== "string" || token.length < 1 || token.length > MAX_TOKEN) return json(400, { error: "bad_json" });

  const reason = await siteverify(env, token, request.headers.get("CF-Connecting-IP"));
  console.log(JSON.stringify({ path: "/api/pass", ok: reason === "ok", reason }));
  if (reason !== "ok") return json(403, { error: "unverified" });
  const body: PassResponse = { pass: await mintPass(env, nowS()), expires_in: PASS_TTL_S };
  return json(200, body);
}

async function handleNext(request: Request, env: Env): Promise<Response> {
  const mode = verificationMode(env);
  if (mode === "misconfigured") {
    // Sitekey set but a secret missing: fail closed rather than serve unprotected.
    console.log(JSON.stringify({ path: "/api/next", misconfigured: true }));
    return json(503, { error: "disabled" });
  }
  const blocked = await preBodyGuards(request, env);
  if (blocked !== null) return blocked;

  if (mode === "enabled") {
    const pass = request.headers.get(PASS_HEADER);
    if (pass === null || !(await verifyPass(env, pass, nowS()))) return json(401, { error: "unverified" });
  }

  const parsed = await readJsonObject(request, MAX_BODY);
  if (parsed instanceof Response) return parsed;
  const { expression, prefix } = parsed;
  if (typeof expression !== "string" || !isValidWireExpression(expression)) {
    return json(400, { error: "invalid_expression" });
  }
  if (typeof prefix !== "string" || !PREFIX_RE.test(prefix)) return json(400, { error: "invalid_prefix" });

  // Gateway first (free credits). On its 429, or two transient failures, fall back once to the
  // direct TypeSafe API — only with a key and while the global FALLBACK_LIMIT budget allows.
  let result = await callRoute(
    { route: "gateway", baseUrl: env.JEV_BASE_URL, key: env.JEV_API_KEY, model: env.JEV_MODEL },
    expression,
    prefix,
  );
  let attempts = result.calls;
  let fallback = false;
  const gatewayDown = result.transientTwice || (result.attempt.kind === "response" && result.attempt.res.status === 429);
  const directKey = typeof env.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY : "";
  if (gatewayDown && directKey !== "" && (await env.FALLBACK_LIMIT.limit({ key: FALLBACK_KEY })).success) {
    fallback = true;
    result = await callRoute(
      { route: "direct", baseUrl: env.TYPESAFE_BASE_URL, key: directKey, model: env.TYPESAFE_MODEL },
      expression,
      prefix,
    );
    attempts += result.calls;
  }
  const { route, attempt } = result;

  // `route` is the upstream whose outcome is reported; `path` was `route` before the fallback existed.
  const log = (status: number, generation_id = "", upstream_ms?: number) =>
    console.log(JSON.stringify({ path: "/api/next", route, fallback, status, attempts, generation_id, upstream_ms }));

  if (attempt.kind === "thrown") {
    const status = attempt.timeout ? TIMEOUT_STATUS : NETWORK_STATUS;
    log(status);
    return json(502, { error: "upstream", status });
  }
  const { res, ms } = attempt;
  if (res.status === 429) {
    log(429, "", ms);
    return rateLimited(parseRetryAfter(res.headers.get("Retry-After")));
  }
  if (!res.ok) {
    log(res.status, "", ms);
    return json(502, { error: "upstream", status: res.status });
  }
  try {
    const mapped = mapResponse(await res.json());
    log(res.status, mapped.generation_id, ms);
    return json(200, { ...mapped, upstream_ms: ms, route });
  } catch (e) {
    // Unparseable or wrongly shaped 2xx: the upstream broke the contract.
    log(res.status, "", ms);
    console.log(`upstream shape error: ${e instanceof JevResponseError ? e.message : "invalid JSON"}`);
    return json(502, { error: "upstream", status: res.status });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/next") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
      return handleNext(request, env);
    }
    if (pathname === "/api/config") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
      return handleConfig(env);
    }
    // While verification is off the route does not exist (falls to the 404 below).
    if (pathname === "/api/pass" && verificationMode(env) === "enabled") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
      return handlePass(request, env);
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) return json(404, { error: "not_found" });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
