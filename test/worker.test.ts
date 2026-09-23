// Runs inside workerd via @cloudflare/vitest-pool-workers. The handler is imported and called
// directly with a wrapped env (fake ASSETS / API_LIMIT / FALLBACK_LIMIT / keys, real wrangler.jsonc
// vars), and both upstreams are one recording fake installed with vi.stubGlobal("fetch", …) — the
// handler module shares this isolate, so its global fetch is the fake. The fake routes by URL:
// gateway requests take replies from `upstreamReplies`, direct-API requests from `directReplies`.
// fakeEnv() leaves TYPESAFE_API_KEY unset (fallback disabled); the fallback tests pass DIRECT_KEY.
// Turnstile: siteverify requests take replies from `siteverifyReplies`. fakeEnv() leaves the
// sitekey "" and both secrets unset (verification disabled, as before); turnstileEnv() enables it.
import { env as realEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY, OPTIONS, PASS_HEADER, PASS_TTL_S } from "../shared/protocol";
import worker, { type Env } from "../worker/index";
import { ACTIVE_PROMPT, buildRequest } from "../worker/jev";
import { mintPass, verifyPass } from "../worker/pass";
import { expectedRequest } from "./helpers/expected-request";
import response13 from "./fixtures/gateway-response.13opt.json";
import directResponse from "./fixtures/direct-response.recorded.json";

const KEY = "test-key-not-real-7f3a";
const DIRECT_KEY = "ts-test-key-not-real-91c4";
const ORIGIN = "https://jev.example";
const API = `${ORIGIN}/api/next`;
const GATEWAY_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
const DIRECT_URL = "https://api.typesafe.ai/v1/systemone";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const PASS_API = `${ORIGIN}/api/pass`;
const SITEKEY = "0x4AAAAAAAtestsitekey";
const TURNSTILE_SECRET = "0x4AAAAAAA-turnstile-secret-not-real-5d21";
const PASS_SECRET = "pass-secret-not-real-e83a";
const HOST = "jev-calculator.cloudflare-jjx3a.workers.dev";

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

type UpstreamReply = Response | Error;

let upstreamCalls: UpstreamCall[]; // every outbound call, both hosts, in order
let upstreamReplies: UpstreamReply[]; // gateway replies
let directReplies: UpstreamReply[]; // direct TypeSafe API replies
let siteverifyReplies: UpstreamReply[]; // Turnstile siteverify replies
let secretsInLogs: string[]; // Turnstile tokens sent and passes issued: must never reach a log line
let fakeFaults: string[]; // test-script bugs (unknown host, unscripted reply); must stay empty
let limiterCalls: Array<{ key: string }>;
let limiterSuccess: boolean;
let fallbackLimiterCalls: Array<{ key: string }>;
let fallbackLimiterSuccess: boolean;
let assetRequests: string[];
let logs: string[];
let responseBodies: string[];

const gatewayCalls = () => upstreamCalls.filter((c) => c.url === GATEWAY_URL);
const directCalls = () => upstreamCalls.filter((c) => c.url === DIRECT_URL);
const siteverifyCalls = () => upstreamCalls.filter((c) => c.url === SITEVERIFY_URL);
const apiLogs = () => logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

function fakeEnv(overrides: Partial<Env> = {}): Env {
  const vars = realEnv as unknown as Record<string, string>;
  return {
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        assetRequests.push(new Request(input).url);
        return new Response("<!doctype html><title>Jev</title>", { headers: { "Content-Type": "text/html" } });
      },
    } as unknown as Fetcher,
    API_LIMIT: {
      limit: async (opts: { key: string }) => {
        limiterCalls.push(opts);
        return { success: limiterSuccess };
      },
    } as RateLimit,
    FALLBACK_LIMIT: {
      limit: async (opts: { key: string }) => {
        fallbackLimiterCalls.push(opts);
        return { success: fallbackLimiterSuccess };
      },
    } as RateLimit,
    JEV_API_KEY: KEY,
    // From wrangler.jsonc via the pool, so the test also pins the deployed config.
    JEV_BASE_URL: vars.JEV_BASE_URL!,
    JEV_MODEL: vars.JEV_MODEL!,
    JEV_DISABLED: vars.JEV_DISABLED!,
    TYPESAFE_BASE_URL: vars.TYPESAFE_BASE_URL!,
    TYPESAFE_MODEL: vars.TYPESAFE_MODEL!,
    // Hard-coded, not from `vars`: a local .dev.vars (Turnstile test keys) must not flip these tests.
    TURNSTILE_SITEKEY: "",
    TURNSTILE_HOSTNAMES: HOST,
    ...overrides,
  };
}

/** Verification enabled: sitekey + both secrets, the deployed hostname allowlist. */
function turnstileEnv(overrides: Partial<Env> = {}): Env {
  return fakeEnv({ TURNSTILE_SITEKEY: SITEKEY, TURNSTILE_SECRET, PASS_SECRET, ...overrides });
}

function upstreamOk(body: unknown = response13): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function upstreamStatus(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { type: "x" } }), { status, headers });
}

function post(body: unknown, init: { headers?: Record<string, string>; raw?: BodyInit } = {}): Request {
  return new Request(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9", ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  });
}

async function call(req: Request, env: Env = fakeEnv()) {
  const res = await worker.fetch(req, env, {} as ExecutionContext);
  const text = await res.text();
  responseBodies.push(text);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (typeof json?.pass === "string") secretsInLogs.push(json.pass); // every issued pass: never in a log line
  return { res, json, text };
}

function expectApiHeaders(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Type")).toBe("application/json");
}

beforeEach(() => {
  upstreamCalls = [];
  upstreamReplies = [];
  directReplies = [];
  siteverifyReplies = [];
  secretsInLogs = [];
  fakeFaults = [];
  limiterCalls = [];
  limiterSuccess = true;
  fallbackLimiterCalls = [];
  fallbackLimiterSuccess = true;
  assetRequests = [];
  logs = [];
  responseBodies = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    upstreamCalls.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get("Authorization"),
      contentType: req.headers.get("Content-Type"),
      body: new TextDecoder().decode(await req.arrayBuffer()), // .text() warns on form-encoded bodies
    });
    const queue =
      req.url === GATEWAY_URL
        ? upstreamReplies
        : req.url === DIRECT_URL
          ? directReplies
          : req.url === SITEVERIFY_URL
            ? siteverifyReplies
            : undefined;
    const reply = queue?.shift();
    if (reply === undefined) {
      // The handler would swallow this as a network error, so record it for afterEach to fail on.
      fakeFaults.push(queue === undefined ? `unexpected upstream URL ${req.url}` : `no reply scripted for ${req.url}`);
      throw new Error("fake upstream fault");
    }
    if (reply instanceof Error) throw reply;
    return reply;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(fakeFaults).toEqual([]);
  // No key or secret may reach a log line or a response body …
  const seen = [...logs, ...responseBodies].join("\n");
  for (const secret of [KEY, DIRECT_KEY, TURNSTILE_SECRET, PASS_SECRET]) expect(seen).not.toContain(secret);
  // … and no Turnstile token or issued pass may reach a log line (a pass is in its own response body).
  const logged = logs.join("\n");
  for (const s of secretsInLogs) expect(logged).not.toContain(s);
});

describe("POST /api/next — happy path", () => {
  it("200 maps the fixture; upstream saw the bearer key and the exact active-prompt body", async () => {
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "1" }));
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(json).toMatchObject({
      choice: "5",
      confidence: 0.73,
      usage: { input_tokens: 378, output_tokens: 102 },
      cost: "0",
      market_cost: "0.000015876",
      generation_id: "gen_01M35JG6980Y50PYPKNGBM2A61",
      route: "gateway",
      model: "typesafe-ai/jev",
    });
    expect(json.probabilities["5"]).toBe(0.76); // re-rounded from 0.7600000000000001
    expect(json.probabilities["9"]).toBe(0.03);
    expect(typeof json.upstream_ms).toBe("number");

    expect(upstreamCalls).toHaveLength(1);
    const up = upstreamCalls[0]!;
    expect(up.url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(up.method).toBe("POST");
    expect(up.authorization).toBe(`Bearer ${KEY}`);
    expect(up.contentType).toBe("application/json");
    expect(JSON.parse(up.body)).toEqual(expectedRequest("typesafe-ai/jev", "12 + 3", "1"));
    expect(up.body).toBe(JSON.stringify(buildRequest("typesafe-ai/jev", "12 + 3", "1")));

    expect(limiterCalls).toEqual([{ key: "203.0.113.9" }]);
    expect(logs.some((l) => l.includes("gen_01M35JG6980Y50PYPKNGBM2A61") && l.includes('"status":200'))).toBe(true);
  });

  // PIN: owner 2026-09-22 (night) — all 13 options offered every step, never masked; the END withholding shipped earlier that evening was reverted ("we keep it as described, no masking"); docs/260922-feat-batch-revert-withhold-ui.md
  it("'123 * 45' with prefix '' → upstream body carries all 13 criteria (END included); 200 body has no `withheld`", async () => {
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(post({ expression: "123 * 45", prefix: "" }));
    expect(res.status).toBe(200);
    expect(json).not.toHaveProperty("withheld");
    expect(json.choice).toBe("5");

    expect(upstreamCalls).toHaveLength(1);
    const sent = JSON.parse(upstreamCalls[0]!.body);
    expect(Object.keys(sent.questions.next_char.criteria)).toEqual([...OPTIONS]);
    expect(sent).toEqual(expectedRequest("typesafe-ai/jev", "123 * 45", ""));
  });

  it("upstream 2xx lacking END for '123 * 45' → 502 upstream status 200 (all 13 keys are the contract)", async () => {
    const reply = structuredClone(response13) as any;
    delete reply.answers.next_char.probabilities.END;
    upstreamReplies = [upstreamOk(reply)];
    const { res, json } = await call(post({ expression: "123 * 45", prefix: "" }));
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status: 200 });
  });

  it("accepts a request without an Origin header and keys the limiter on 'unknown' without CF-Connecting-IP", async () => {
    upstreamReplies = [upstreamOk()];
    const req = new Request(API, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ expression: "1", prefix: "" }) });
    const { res } = await call(req);
    expect(res.status).toBe(200);
    expect(limiterCalls).toEqual([{ key: "unknown" }]);
  });

  it("accepts every prefix PREFIX_RE allows, including malformed ones like '--' and '1.2.'", async () => {
    upstreamReplies = [upstreamOk(), upstreamOk()];
    for (const prefix of ["--", "1.2."]) {
      const { res } = await call(post({ expression: "3 - 5", prefix }));
      expect(res.status).toBe(200);
    }
    expect(upstreamCalls.map((c) => JSON.parse(c.body).state)).toEqual(["--", "1.2."].map((p) => ACTIVE_PROMPT.state("3 - 5", p)));
  });
});

describe("POST /api/next — rejected before any upstream call", () => {
  const cases: Array<[string, () => Request, number, string]> = [
    ["bad JSON", () => post(null, { raw: "{not json" }), 400, "bad_json"],
    ["JSON array", () => post([1, 2]), 400, "bad_json"],
    ["wrong Content-Type", () => post({ expression: "1", prefix: "" }, { headers: { "Content-Type": "text/plain" } }), 400, "bad_json"],
    ["oversized body (Content-Length)", () => post({ expression: "1", prefix: "", pad: "x".repeat(MAX_BODY) }), 400, "body_too_large"],
    [
      "oversized body (streamed, no Content-Length)",
      () =>
        post(null, {
          raw: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(JSON.stringify({ expression: "1", prefix: "", pad: "x".repeat(MAX_BODY) })));
              c.close();
            },
          }),
        }),
      400,
      "body_too_large",
    ],
    ["bad expression (incomplete)", () => post({ expression: "12 +", prefix: "" }), 400, "invalid_expression"],
    ["bad expression (display form)", () => post({ expression: "3 × 5", prefix: "" }), 400, "invalid_expression"],
    ["bad expression (mod divisor 0)", () => post({ expression: "7 mod 0", prefix: "" }), 400, "invalid_expression"],
    ["bad expression (65 chars)", () => post({ expression: "1 + " + "1".repeat(61), prefix: "" }), 400, "invalid_expression"],
    ["expression missing", () => post({ prefix: "" }), 400, "invalid_expression"],
    ["bad prefix (1e5)", () => post({ expression: "12 + 3", prefix: "1e5" }), 400, "invalid_prefix"],
    ["bad prefix (25 chars)", () => post({ expression: "12 + 3", prefix: "1".repeat(25) }), 400, "invalid_prefix"],
    ["prefix not a string", () => post({ expression: "12 + 3", prefix: 1 }), 400, "invalid_prefix"],
    ["foreign Origin", () => post({ expression: "12 + 3", prefix: "" }, { headers: { Origin: "https://evil.example" } }), 403, "bad_origin"],
  ];

  it.each(cases)("%s → %i %s, zero upstream calls", async (_name, make, status, error) => {
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(make());
    expect(res.status).toBe(status);
    expect(json).toEqual({ error });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("the streamed oversize request really had no Content-Length", () => {
    const req = post(null, { raw: new ReadableStream({ start: (c) => c.close() }) });
    expect(req.headers.get("Content-Length")).toBeNull();
  });

  it("JEV_DISABLED=1 → 503 disabled, zero upstream calls, limiter not consulted", async () => {
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "" }), fakeEnv({ JEV_DISABLED: "1" }));
    expect(res.status).toBe(503);
    expect(json).toEqual({ error: "disabled" });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("own limiter success:false → 429 retry_after_s 10 + Retry-After, zero upstream calls", async () => {
    limiterSuccess = false;
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 10 });
    expect(res.headers.get("Retry-After")).toBe("10");
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("POST /api/next — upstream errors", () => {
  it("upstream 429 with retry-after: 37 → 429 retry_after_s 37, no retry", async () => {
    upstreamReplies = [upstreamStatus(429, { "retry-after": "37" }), upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 37 });
    expect(res.headers.get("Retry-After")).toBe("37");
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("upstream 429 without retry-after → retry_after_s 60", async () => {
    upstreamReplies = [upstreamStatus(429)];
    const { json } = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 60 });
  });

  it("503 then 200 → 200 with exactly two upstream calls, same body both times", async () => {
    upstreamReplies = [upstreamStatus(503), upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "1" }));
    expect(res.status).toBe(200);
    expect(json.choice).toBe("5");
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]!.body).toBe(upstreamCalls[0]!.body);
  });

  it.each([502, 503, 529])("%i twice → 502 upstream with that status, exactly two calls", async (status) => {
    upstreamReplies = [upstreamStatus(status), upstreamStatus(status), upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(2);
  });

  it("timeout twice → 502 status 504, exactly two calls; timeout then 200 → 200", async () => {
    const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
    upstreamReplies = [timeout(), timeout(), upstreamOk()];
    const first = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(first.res.status).toBe(502);
    expect(first.json).toEqual({ error: "upstream", status: 504 });
    expect(upstreamCalls).toHaveLength(2);

    upstreamCalls = [];
    upstreamReplies = [timeout(), upstreamOk()];
    const second = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(second.res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
  });

  it.each([400, 401, 500])("other non-2xx %i → 502 with that status, no retry", async (status) => {
    upstreamReplies = [upstreamStatus(status), upstreamOk()];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status });
    expect(upstreamCalls).toHaveLength(1);
  });

  it("2xx with a malformed body (12-option era, no '-') → 502 upstream status 200", async () => {
    const twelve = structuredClone(response13) as any;
    delete twelve.answers.next_char.probabilities["-"];
    upstreamReplies = [upstreamOk(twelve)];
    const { res, json } = await call(post({ expression: "12 + 3", prefix: "" }));
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status: 200 });
  });
});

describe("POST /api/next — direct TypeSafe fallback", () => {
  const withKey = (overrides: Partial<Env> = {}) => fakeEnv({ TYPESAFE_API_KEY: DIRECT_KEY, ...overrides });
  const req = () => post({ expression: "12 + 3", prefix: "1" });
  const gateway429 = () => upstreamStatus(429, { "retry-after": "37" });

  it("gateway 200 → route gateway, zero direct calls, FALLBACK_LIMIT not consulted", async () => {
    upstreamReplies = [upstreamOk()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ route: "gateway", model: "typesafe-ai/jev", generation_id: "gen_01M35JG6980Y50PYPKNGBM2A61" });
    expect(gatewayCalls()).toHaveLength(1);
    expect(directCalls()).toHaveLength(0);
    expect(fallbackLimiterCalls).toHaveLength(0);
    expect(apiLogs()).toEqual([expect.objectContaining({ route: "gateway", fallback: false, status: 200, attempts: 1 })]);
  });

  it("direct route for '123 * 45' too: both bodies carry all 13 criteria, direct 200 has no `withheld`", async () => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(post({ expression: "123 * 45", prefix: "12" }), withKey());
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ route: "direct" });
    expect(json).not.toHaveProperty("withheld");
    const [gw, direct] = upstreamCalls;
    expect(JSON.parse(gw!.body)).toEqual(expectedRequest("typesafe-ai/jev", "123 * 45", "12"));
    expect(JSON.parse(direct!.body)).toEqual(expectedRequest("jev-latest", "123 * 45", "12"));
    expect(Object.keys(JSON.parse(direct!.body).questions.next_char.criteria)).toEqual([...OPTIONS]);
  });

  it("gateway 429, key present, budget ok → direct 200 with the TypeSafe key and model, route direct", async () => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(json).toMatchObject({
      route: "direct",
      model: "jev-1.13.0",
      choice: "5",
      confidence: 0.81,
      cost: "",
      market_cost: "",
      generation_id: "",
    });
    expect(typeof json.upstream_ms).toBe("number");

    expect(upstreamCalls.map((c) => c.url)).toEqual([GATEWAY_URL, DIRECT_URL]);
    const [gw, direct] = upstreamCalls;
    expect(gw!.authorization).toBe(`Bearer ${KEY}`);
    expect(direct!.method).toBe("POST");
    expect(direct!.authorization).toBe(`Bearer ${DIRECT_KEY}`);
    expect(direct!.contentType).toBe("application/json");
    expect(JSON.parse(direct!.body)).toEqual(expectedRequest("jev-latest", "12 + 3", "1"));
    expect(JSON.parse(gw!.body).model).toBe("typesafe-ai/jev");

    expect(fallbackLimiterCalls).toEqual([{ key: "direct" }]);
    expect(apiLogs()).toEqual([expect.objectContaining({ route: "direct", fallback: true, status: 200, attempts: 2 })]);
  });

  it("gateway 429, key present, FALLBACK_LIMIT refuses → gateway's 429 (retry_after_s 37), zero direct calls", async () => {
    fallbackLimiterSuccess = false;
    upstreamReplies = [gateway429()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 37 });
    expect(res.headers.get("Retry-After")).toBe("37");
    expect(fallbackLimiterCalls).toEqual([{ key: "direct" }]);
    expect(directCalls()).toHaveLength(0);
    expect(apiLogs()).toEqual([expect.objectContaining({ route: "gateway", fallback: false, status: 429 })]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
  ])("gateway 429, TYPESAFE_API_KEY %s → 429, FALLBACK_LIMIT not consulted, zero direct calls", async (_n, key) => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(req(), fakeEnv({ TYPESAFE_API_KEY: key }));
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 37 });
    expect(fallbackLimiterCalls).toHaveLength(0);
    expect(directCalls()).toHaveLength(0);
  });

  it("gateway 503 twice, key present, budget ok → direct 200 (2 gateway + 1 direct calls)", async () => {
    upstreamReplies = [upstreamStatus(503), upstreamStatus(503), upstreamOk()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(200);
    expect(json.route).toBe("direct");
    expect(upstreamCalls.map((c) => c.url)).toEqual([GATEWAY_URL, GATEWAY_URL, DIRECT_URL]);
    expect(apiLogs()).toEqual([expect.objectContaining({ route: "direct", fallback: true, attempts: 3 })]);
  });

  it("gateway timeout twice → direct 200", async () => {
    const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
    upstreamReplies = [timeout(), timeout()];
    directReplies = [upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(200);
    expect(json.route).toBe("direct");
    expect(upstreamCalls.map((c) => c.url)).toEqual([GATEWAY_URL, GATEWAY_URL, DIRECT_URL]);
  });

  it("gateway 503 twice, FALLBACK_LIMIT refuses → 502 upstream status 503, zero direct calls", async () => {
    fallbackLimiterSuccess = false;
    upstreamReplies = [upstreamStatus(503), upstreamStatus(503)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status: 503 });
    expect(directCalls()).toHaveLength(0);
  });

  it("gateway 503 then 200 → gateway answer, no fallback", async () => {
    upstreamReplies = [upstreamStatus(503), upstreamOk()];
    const { json } = await call(req(), withKey());
    expect(json.route).toBe("gateway");
    expect(fallbackLimiterCalls).toHaveLength(0);
    expect(directCalls()).toHaveLength(0);
  });

  it.each([400, 401, 500])("gateway non-transient %i → 502, no fallback", async (status) => {
    upstreamReplies = [upstreamStatus(status)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status });
    expect(fallbackLimiterCalls).toHaveLength(0);
    expect(directCalls()).toHaveLength(0);
  });

  it("gateway 2xx with a malformed body → 502, no fallback", async () => {
    const bad = structuredClone(response13) as any;
    delete bad.answers;
    upstreamReplies = [upstreamOk(bad)];
    const { res } = await call(req(), withKey());
    expect(res.status).toBe(502);
    expect(directCalls()).toHaveLength(0);
  });

  it("gateway 429 → direct 429 (retry-after 5) → 429 retry_after_s 5, direct not retried", async () => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamStatus(429, { "retry-after": "5" }), upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 5 });
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(directCalls()).toHaveLength(1);
  });

  it("gateway 429 → direct 429 without retry-after → retry_after_s 60", async () => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamStatus(429)];
    const { json } = await call(req(), withKey());
    expect(json).toEqual({ error: "rate_limited", retry_after_s: 60 });
  });

  it("gateway 429 → direct 503 then 200 → 200 route direct (exactly one direct retry, same body)", async () => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamStatus(503), upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(200);
    expect(json.route).toBe("direct");
    const direct = directCalls();
    expect(direct).toHaveLength(2);
    expect(direct[1]!.body).toBe(direct[0]!.body);
    expect(apiLogs()).toEqual([expect.objectContaining({ route: "direct", fallback: true, attempts: 3 })]);
  });

  it("gateway 429 → direct 503 twice → 502 status 503; no further fallback", async () => {
    upstreamReplies = [gateway429(), upstreamOk()];
    directReplies = [upstreamStatus(503), upstreamStatus(503), upstreamOk(directResponse)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status: 503 });
    expect(upstreamCalls.map((c) => c.url)).toEqual([GATEWAY_URL, DIRECT_URL, DIRECT_URL]);
    expect(fallbackLimiterCalls).toHaveLength(1);
  });

  it.each([401, 500])("gateway 429 → direct %i → 502 with that status", async (status) => {
    upstreamReplies = [gateway429()];
    directReplies = [upstreamStatus(status)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status });
    expect(directCalls()).toHaveLength(1);
  });

  it("gateway 429 → direct 2xx with a malformed body → 502 upstream status 200", async () => {
    const bad = structuredClone(directResponse) as any;
    delete bad.usage;
    upstreamReplies = [gateway429()];
    directReplies = [upstreamOk(bad)];
    const { res, json } = await call(req(), withKey());
    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "upstream", status: 200 });
  });
});

// --- Turnstile bot protection ------------------------------------------------------------------

const nowS = () => Math.floor(Date.now() / 1000);

function siteOk(over: Record<string, unknown> = {}): Response {
  const body = { success: true, action: "solve", hostname: HOST, "error-codes": [], challenge_ts: "2026-09-22T00:00:00Z", ...over };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** POST /api/pass with {token}; the token is registered for the log-leak check. */
function passReq(body: unknown, init: { headers?: Record<string, string>; raw?: BodyInit } = {}): Request {
  if (typeof body === "object" && body !== null && typeof (body as { token?: unknown }).token === "string") {
    const token = (body as { token: string }).token;
    if (token.length >= 8) secretsInLogs.push(token);
  }
  return new Request(PASS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9", ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  });
}

/** POST /api/next carrying `pass` in PASS_HEADER (registered for the log-leak check). */
function nextWithPass(pass: string, body: unknown = { expression: "12 + 3", prefix: "1" }): Request {
  if (pass.length >= 8) secretsInLogs.push(pass);
  return post(body, { headers: { [PASS_HEADER]: pass } });
}

const passLogs = () => apiLogs().filter((l) => l.path === "/api/pass");

describe("GET /api/config", () => {
  it("disabled (default config) → 200 {turnstile_sitekey: null}, no-store", async () => {
    const { res, json } = await call(new Request(`${ORIGIN}/api/config`));
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(json).toEqual({ turnstile_sitekey: null });
    expect(limiterCalls).toHaveLength(0);
  });

  it("enabled → 200 with the sitekey", async () => {
    const { res, json } = await call(new Request(`${ORIGIN}/api/config`), turnstileEnv());
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(json).toEqual({ turnstile_sitekey: SITEKEY });
  });

  it.each([
    ["PASS_SECRET", { PASS_SECRET: undefined }],
    ["TURNSTILE_SECRET", { TURNSTILE_SECRET: "" }],
  ])("misconfigured (sitekey set, %s missing) → null", async (_n, over) => {
    const { json } = await call(new Request(`${ORIGIN}/api/config`), turnstileEnv(over));
    expect(json).toEqual({ turnstile_sitekey: null });
  });

  it("POST /api/config → 405 Allow: GET", async () => {
    const { res, json } = await call(new Request(`${ORIGIN}/api/config`, { method: "POST" }), turnstileEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(json).toEqual({ error: "method_not_allowed" });
    expectApiHeaders(res);
  });
});

describe("POST /api/pass", () => {
  it("siteverify ok → 200 {pass, expires_in}; the pass verifies; siteverify saw form-encoded secret/response/remoteip", async () => {
    siteverifyReplies = [siteOk()];
    const env = turnstileEnv();
    const t0 = nowS();
    const { res, json } = await call(passReq({ token: "tok.0123456789.abc" }), env);
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(json).toEqual({ pass: expect.any(String), expires_in: PASS_TTL_S });
    secretsInLogs.push(json.pass);
    expect(await verifyPass(env, json.pass, nowS())).toBe(true);
    expect(await verifyPass(env, json.pass, t0 + PASS_TTL_S + 1)).toBe(false); // exp ≈ now + PASS_TTL_S

    expect(upstreamCalls).toHaveLength(1);
    const sv = siteverifyCalls()[0]!;
    expect(sv.method).toBe("POST");
    expect(sv.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(sv.body))).toEqual({
      secret: TURNSTILE_SECRET,
      response: "tok.0123456789.abc",
      remoteip: "203.0.113.9",
    });
    expect(limiterCalls).toEqual([{ key: "203.0.113.9" }]);
    expect(passLogs()).toEqual([{ path: "/api/pass", ok: true, reason: "ok" }]);
  });

  it("no CF-Connecting-IP → no remoteip field", async () => {
    siteverifyReplies = [siteOk()];
    const req = new Request(PASS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "tok-without-ip" }),
    });
    secretsInLogs.push("tok-without-ip");
    const { res } = await call(req, turnstileEnv());
    expect(res.status).toBe(200);
    expect([...new URLSearchParams(siteverifyCalls()[0]!.body).keys()].sort()).toEqual(["response", "secret"]);
  });

  it("a 2048-char token is accepted (the body cap leaves room for it)", async () => {
    siteverifyReplies = [siteOk()];
    const token = "t".repeat(2048);
    const { res } = await call(passReq({ token }), turnstileEnv());
    expect(res.status).toBe(200);
    expect(new URLSearchParams(siteverifyCalls()[0]!.body).get("response")).toBe(token);
  });

  const rejected: Array<[string, () => UpstreamReply, string, Partial<Env>?]> = [
    ["success:false", () => siteOk({ success: false, "error-codes": ["invalid-input-response"] }), "siteverify_failed"],
    ["success:'true' (not boolean)", () => siteOk({ success: "true" }), "siteverify_failed"],
    ["wrong action", () => siteOk({ action: "login" }), "bad_action"],
    ["action missing (real sitekey)", () => siteOk({ action: undefined }), "bad_action"],
    ["hostname not in allowlist", () => siteOk({ hostname: "evil.example" }), "bad_hostname"],
    ["hostname missing", () => siteOk({ hostname: undefined }), "bad_hostname"],
    ["empty allowlist", () => siteOk(), "bad_hostname", { TURNSTILE_HOSTNAMES: "" }],
    ["siteverify 500", () => new Response("oops", { status: 500 }), "siteverify_failed"],
    ["siteverify non-JSON 200", () => new Response("<html>", { status: 200 }), "siteverify_failed"],
    ["siteverify JSON null", () => new Response("null", { status: 200 }), "siteverify_failed"],
    ["network error", () => new TypeError("fetch failed"), "network"],
    ["timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), "network"],
  ];

  it.each(rejected)("%s → 403 unverified, no pass, logged reason %s", async (_n, reply, reason, over) => {
    siteverifyReplies = [reply()];
    const { res, json } = await call(passReq({ token: "tok-rejected-1234" }), turnstileEnv(over));
    expect(res.status).toBe(403);
    expectApiHeaders(res);
    expect(json).toEqual({ error: "unverified" });
    expect(siteverifyCalls()).toHaveLength(1);
    expect(passLogs()).toEqual([{ path: "/api/pass", ok: false, reason }]);
  });

  it("test sitekey (1x0000…): no action in the reply is accepted; hostname still checked", async () => {
    // Observed 2026-09-22 with the test secret: {success:true, hostname:"example.com", error-codes:[], metadata:{…}}.
    const testReply = () => siteOk({ action: undefined, hostname: "example.com", metadata: { result_with_testing_key: true } });
    siteverifyReplies = [testReply(), testReply()];
    const dev = turnstileEnv({ TURNSTILE_SITEKEY: "1x00000000000000000000AA", TURNSTILE_HOSTNAMES: "example.com" });
    const ok = await call(passReq({ token: "XXXX.DUMMY.TOKEN.XXXX" }), dev);
    expect(ok.res.status).toBe(200);
    secretsInLogs.push(ok.json.pass);
    const wrongHost = await call(passReq({ token: "XXXX.DUMMY.TOKEN.XXXX" }), { ...dev, TURNSTILE_HOSTNAMES: HOST });
    expect(wrongHost.res.status).toBe(403);
    expect(passLogs().map((l) => l.reason)).toEqual(["ok", "bad_hostname"]);
  });

  const bad: Array<[string, () => Request, number, string]> = [
    ["token missing", () => passReq({}), 400, "bad_json"],
    ["token empty", () => passReq({ token: "" }), 400, "bad_json"],
    ["token 2049 chars", () => passReq({ token: "t".repeat(2049) }), 400, "bad_json"],
    ["token not a string", () => passReq({ token: 42 }), 400, "bad_json"],
    ["bad JSON", () => passReq(null, { raw: "{not json" }), 400, "bad_json"],
    ["wrong Content-Type", () => passReq({ token: "tok-ctype-1234" }, { headers: { "Content-Type": "text/plain" } }), 400, "bad_json"],
    ["body over 4 KiB", () => passReq({ token: "t", pad: "x".repeat(4096) }), 400, "body_too_large"],
    ["foreign Origin", () => passReq({ token: "tok-origin-1234" }, { headers: { Origin: "https://evil.example" } }), 403, "bad_origin"],
  ];

  it.each(bad)("%s → %i %s, zero siteverify calls", async (_n, make, status, error) => {
    siteverifyReplies = [siteOk()];
    const { res, json } = await call(make(), turnstileEnv());
    expect(res.status).toBe(status);
    expect(json).toEqual({ error });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("kill switch → 503 disabled; own limiter refuses → 429; zero siteverify calls", async () => {
    siteverifyReplies = [siteOk()];
    const off = await call(passReq({ token: "tok-killswitch-1" }), turnstileEnv({ JEV_DISABLED: "1" }));
    expect(off.res.status).toBe(503);
    expect(off.json).toEqual({ error: "disabled" });
    limiterSuccess = false;
    const limited = await call(passReq({ token: "tok-limited-1234" }), turnstileEnv());
    expect(limited.res.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited", retry_after_s: 10 });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("GET /api/pass (enabled) → 405 Allow: POST", async () => {
    const { res, json } = await call(new Request(PASS_API), turnstileEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(json).toEqual({ error: "method_not_allowed" });
  });

  it.each([
    ["disabled (default)", () => fakeEnv()],
    ["misconfigured (no PASS_SECRET)", () => turnstileEnv({ PASS_SECRET: undefined })],
  ])("%s → POST /api/pass is 404 not_found, zero calls", async (_n, env) => {
    siteverifyReplies = [siteOk()];
    const { res, json } = await call(passReq({ token: "tok-disabled-1234" }), env());
    expect(res.status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
    expect(limiterCalls).toHaveLength(0);
  });
});

describe("POST /api/next — Turnstile pass required when enabled", () => {
  const unverified = async (req: Request, env: Env = turnstileEnv()) => {
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(req, env);
    expect(res.status).toBe(401);
    expect(json).toEqual({ error: "unverified" });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
  };

  it("no pass → 401 unverified, zero upstream calls (limiter still consulted first)", async () => {
    await unverified(post({ expression: "12 + 3", prefix: "" }));
    expect(limiterCalls).toEqual([{ key: "203.0.113.9" }]);
  });

  it("tampered pass → 401", async () => {
    const pass = await mintPass({ PASS_SECRET }, nowS());
    const [payload, sig] = pass.split(".") as [string, string];
    const flipped = sig.slice(0, 3) + (sig[3] === "A" ? "B" : "A") + sig.slice(4);
    await unverified(nextWithPass(`${payload}.${flipped}`));
  });

  it("expired pass → 401", async () => {
    await unverified(nextWithPass(await mintPass({ PASS_SECRET }, nowS() - PASS_TTL_S - 1)));
  });

  it("pass signed with another secret → 401; garbage pass → 401", async () => {
    await unverified(nextWithPass(await mintPass({ PASS_SECRET: "some-other-secret" }, nowS())));
    await unverified(nextWithPass("not-a-pass"));
  });

  it("the pass is checked before the body: no pass + bad body → 401, not 400", async () => {
    await unverified(post(null, { raw: "{not json" }));
  });

  it("kill switch and Origin still come first: 503 / 403 without a pass", async () => {
    const off = await call(post({ expression: "12 + 3", prefix: "" }), turnstileEnv({ JEV_DISABLED: "1" }));
    expect(off.res.status).toBe(503);
    const foreign = await call(post({ expression: "12 + 3", prefix: "" }, { headers: { Origin: "https://evil.example" } }), turnstileEnv());
    expect(foreign.res.status).toBe(403);
    expect(foreign.json).toEqual({ error: "bad_origin" });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("full flow: a pass minted by /api/pass → /api/next reaches the gateway → 200", async () => {
    const env = turnstileEnv();
    siteverifyReplies = [siteOk()];
    const issued = await call(passReq({ token: "tok-flow-0123456789" }), env);
    expect(issued.res.status).toBe(200);
    upstreamReplies = [upstreamOk()];
    const { res, json } = await call(nextWithPass(issued.json.pass), env);
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ choice: "5", route: "gateway" });
    expect(upstreamCalls.map((c) => c.url)).toEqual([SITEVERIFY_URL, GATEWAY_URL]);
    // The pass header is not forwarded upstream: the gateway body is the usual active-prompt request.
    expect(JSON.parse(gatewayCalls()[0]!.body)).toEqual(expectedRequest("typesafe-ai/jev", "12 + 3", "1"));
  });

  it.each([
    ["PASS_SECRET missing", { PASS_SECRET: undefined }],
    ["TURNSTILE_SECRET empty", { TURNSTILE_SECRET: "" }],
  ])("misconfigured (sitekey set, %s) → 503 disabled, logged, zero upstream calls, even with a pass", async (_n, over) => {
    upstreamReplies = [upstreamOk()];
    const pass = await mintPass({ PASS_SECRET }, nowS());
    const { res, json } = await call(nextWithPass(pass), turnstileEnv(over));
    expect(res.status).toBe(503);
    expect(json).toEqual({ error: "disabled" });
    expectApiHeaders(res);
    expect(upstreamCalls).toHaveLength(0);
    expect(apiLogs()).toEqual([{ path: "/api/next", misconfigured: true }]);
  });

  it("disabled: /api/next needs no pass, and a garbage pass header is ignored", async () => {
    upstreamReplies = [upstreamOk(), upstreamOk()];
    const plain = await call(post({ expression: "12 + 3", prefix: "1" }));
    expect(plain.res.status).toBe(200);
    const garbage = await call(nextWithPass("garbage-pass-value"));
    expect(garbage.res.status).toBe(200);
    expect(gatewayCalls()).toHaveLength(2);
  });
});

describe("routing", () => {
  it("GET / is served by ASSETS, no API headers forced", async () => {
    const { res, text } = await call(new Request(`${ORIGIN}/`));
    expect(res.status).toBe(200);
    expect(text).toContain("<title>Jev</title>");
    expect(assetRequests).toEqual([`${ORIGIN}/`]);
    expect(limiterCalls).toHaveLength(0);
  });

  it("GET /api/next → 405 JSON with Allow: POST", async () => {
    const { res, json } = await call(new Request(API));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(json).toEqual({ error: "method_not_allowed" });
    expectApiHeaders(res);
    expect(assetRequests).toHaveLength(0);
  });

  it.each(["/api", "/api/", "/api/other", "/api/next/x"])("POST %s → 404 JSON, not ASSETS", async (path) => {
    const { res, json } = await call(new Request(`${ORIGIN}${path}`, { method: "POST" }));
    expect(res.status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
    expectApiHeaders(res);
    expect(assetRequests).toHaveLength(0);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("the pool's real env carries the wrangler.jsonc bindings the handler expects", () => {
    const e = realEnv as unknown as Record<string, unknown>;
    expect(e.JEV_BASE_URL).toBe("https://ai-gateway.vercel.sh/typesafe");
    expect(e.JEV_MODEL).toBe("typesafe-ai/jev");
    expect(e.JEV_DISABLED).toBe("0");
    expect(e.TYPESAFE_BASE_URL).toBe("https://api.typesafe.ai");
    expect(e.TYPESAFE_MODEL).toBe("jev-latest");
    expect(typeof e.TURNSTILE_SITEKEY).toBe("string");
    expect(typeof e.TURNSTILE_HOSTNAMES).toBe("string");
    expect(typeof (e.API_LIMIT as RateLimit).limit).toBe("function");
    expect(typeof (e.FALLBACK_LIMIT as RateLimit).limit).toBe("function");
    expect(typeof (e.ASSETS as Fetcher).fetch).toBe("function");
  });
});
