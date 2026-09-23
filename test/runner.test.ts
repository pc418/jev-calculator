import { describe, expect, it, vi } from "vitest";
import { MAX_PREFIX, OPTIONS, PASS_HEADER, type NextResponse, type Option } from "../shared/protocol";
import { RUN_RETRY_CEILING, Runner, type RunSnapshot, type RunnerOptions } from "../src/runner";

const WIRE = "12 + 3";
const DISPLAY = "12 + 3";

function answer(choice: Option): NextResponse {
  const probabilities = Object.fromEntries(OPTIONS.map((o) => [o, o === choice ? 0.7 : 0.025])) as Record<Option, number>;
  return {
    choice,
    confidence: 0.68,
    probabilities,
    withheld: [],
    upstream_ms: 400,
    usage: { input_tokens: 380, output_tokens: 100 },
    cost: "0",
    market_cost: "0.000016",
    generation_id: `gen_${choice}`,
  };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

type Reply =
  | Option
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throws: Error }
  | { pending: Promise<Response> };

interface Call {
  url: string;
  expression: string;
  prefix: string;
  /** What the prefix must be: every non-END choice this fake has answered so far, in order. */
  expected: string;
  signal: AbortSignal | undefined;
  headers: Record<string, string>;
}

/**
 * Fake /api/next. Records each request with the prefix it SHOULD carry (the choices it has
 * served so far); tests assert prefix === expected for every call, which stops a runner that
 * ignores or rebuilds the prefix.
 */
function fakeApi(replies: Reply[]) {
  const calls: Call[] = [];
  let emitted = "";
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { expression: string; prefix: string };
    expect(Object.keys(body).sort()).toEqual(["expression", "prefix"]);
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.method).toBe("POST");
    const headers = { ...(init?.headers as Record<string, string>) };
    calls.push({ url: String(url), ...body, expected: emitted, signal: init?.signal ?? undefined, headers });
    const r = replies.shift();
    if (r === undefined) throw new Error("fake api: no reply scripted");
    if (typeof r === "string") {
      if (r !== "END") emitted += r;
      return jsonResponse(200, answer(r));
    }
    if ("throws" in r) throw r.throws;
    if ("pending" in r) return r.pending;
    return jsonResponse(r.status, r.body ?? {}, r.headers);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spy: fetch };
}

function expectPrefixesFollowChoices(calls: Call[]) {
  for (const c of calls) expect(c.prefix, `call ${calls.indexOf(c)}`).toBe(c.expected);
}

function setup(replies: Reply[], extra: Pick<RunnerOptions, "headers"> = {}) {
  let clock = 1_000_000;
  const api = fakeApi(replies);
  const snapshots: RunSnapshot[] = [];
  const runner = new Runner({
    onChange: (s) => snapshots.push(s),
    fetch: api.fetch,
    now: () => clock,
    endpoint: "/api/next",
    ...extra,
  });
  return {
    runner,
    api,
    snapshots,
    advance: (ms: number) => (clock += ms),
    get clock() {
      return clock;
    },
  };
}

const until = (runner: Runner, state: RunSnapshot["state"]) =>
  vi.waitFor(() => expect(runner.snapshot.state).toBe(state), { timeout: 2000, interval: 1 });

/** Lets any pending microtasks (a loop that should NOT continue) run before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 10));

function deferred() {
  let resolve!: (r: Response) => void;
  const pending = new Promise<Response>((r) => (resolve = r));
  return { pending, resolve };
}

describe("Runner", () => {
  it("starts idle", () => {
    const { runner } = setup([]);
    expect(runner.snapshot).toMatchObject({ id: 0, state: "idle", prefix: "", steps: [], retries: 0 });
  });

  // PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
  // PIN: owner+Codex decision 2026-09-22, docs/260922-plan-jev-calculator.md §3.2 — append API choice, never argmax.
  it("appends choice verbatim including '0', '-', '.' (no masking, no repair); END recorded, not appended, nothing follows", async () => {
    const t = setup(["-", "0", ".", ".", "0", "-", "END", "9"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "ended");
    await flush();
    const s = t.runner.snapshot;
    expect(s.prefix).toBe("-0..0-");
    expect(s.steps.map((x) => x.choice)).toEqual(["-", "0", ".", ".", "0", "-", "END"]);
    expect(s.steps.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(t.api.calls).toHaveLength(7); // the scripted "9" is never requested
    expectPrefixesFollowChoices(t.api.calls);
    expect(t.api.calls.every((c) => c.expression === WIRE && c.url === "/api/next")).toBe(true);
    expect(s.expression).toEqual({ display: DISPLAY, wire: WIRE });
  });

  it("records the NextResponse fields plus client_ms on each step", async () => {
    const t = setup(["1", "END"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "ended");
    expect(t.runner.snapshot.steps[0]).toEqual({ ...answer("1"), index: 0, client_ms: 0 });
  });

  // PIN: owner 2026-09-22 — 12-digit operands, 24-char answer cap, docs/260922-plan-jev-calculator.md §3.1/§3.3
  it(`caps at ${MAX_PREFIX} chars: the ${MAX_PREFIX}th char → capped, ${MAX_PREFIX} steps ⇒ ${MAX_PREFIX} requests`, async () => {
    expect(MAX_PREFIX).toBe(24);
    const t = setup(Array.from({ length: MAX_PREFIX + 5 }, (_, i) => String(i % 10) as Option));
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "capped");
    await flush();
    expect(t.runner.snapshot.prefix).toHaveLength(MAX_PREFIX);
    expect(t.runner.snapshot.steps).toHaveLength(MAX_PREFIX);
    expect(t.api.calls).toHaveLength(MAX_PREFIX);
    expectPrefixesFollowChoices(t.api.calls);
  });

  it("does not cache: rerunning the same expression makes every request again", async () => {
    const t = setup(["1", "5", "END", "1", "5", "END"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "ended");
    const firstId = t.runner.snapshot.id;
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "ended");
    expect(t.runner.snapshot.id).toBeGreaterThan(firstId);
    expect(t.api.calls.map((c) => c.prefix)).toEqual(["", "1", "15", "", "1", "15"]);
  });

  it("429 → paused with prefix intact; resume before pausedUntil is a no-op; after it repeats the same step", async () => {
    const t = setup(["1", { status: 429, body: { error: "rate_limited", retry_after_s: 37 }, headers: { "Retry-After": "37" } }, "2", "END"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "paused");
    const paused = t.runner.snapshot;
    expect(paused.prefix).toBe("1");
    expect(paused.steps).toHaveLength(1);
    expect(paused.pausedUntil).toBe(t.clock + 37_000);
    expect(t.api.calls).toHaveLength(2);

    t.advance(36_999);
    const changes = t.snapshots.length;
    t.runner.resume();
    await flush();
    expect(t.runner.snapshot).toBe(paused); // untouched
    expect(t.snapshots).toHaveLength(changes);
    expect(t.api.calls).toHaveLength(2);

    t.advance(1);
    t.runner.resume();
    await until(t.runner, "ended");
    expect(t.api.calls.map((c) => c.prefix)).toEqual(["", "1", "1", "12"]); // same step repeated
    expectPrefixesFollowChoices(t.api.calls);
    expect(t.runner.snapshot.prefix).toBe("12");
    expect(t.runner.snapshot.pausedUntil).toBeUndefined();
  });

  it("429 without a body retry_after_s falls back to the Retry-After header", async () => {
    const t = setup([{ status: 429, body: {}, headers: { "Retry-After": "12" } }]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "paused");
    expect(t.runner.snapshot.pausedUntil).toBe(t.clock + 12_000);
  });

  it("5xx → error; retryStep repeats the failed step", async () => {
    const t = setup(["1", { status: 502, body: { error: "upstream", status: 503 } }, "2", "END"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "error");
    expect(t.runner.snapshot.error).toBe("http 502: upstream");
    expect(t.runner.snapshot.prefix).toBe("1");
    t.runner.retryStep();
    await until(t.runner, "ended");
    expect(t.runner.snapshot.retries).toBe(1);
    expect(t.runner.snapshot.error).toBeUndefined();
    expect(t.api.calls.map((c) => c.prefix)).toEqual(["", "1", "1", "12"]);
    expectPrefixesFollowChoices(t.api.calls);
  });

  it("headers(): its current result is merged into every request, after Content-Type", async () => {
    let pass = "pass-1";
    const first = deferred();
    const t = setup([{ pending: first.pending }, "2", "END"], { headers: () => ({ [PASS_HEADER]: pass }) });
    t.runner.start(DISPLAY, WIRE);
    await vi.waitFor(() => expect(t.api.calls).toHaveLength(1), { interval: 1 });
    pass = "pass-2"; // read per request, not captured once
    first.resolve(jsonResponse(200, answer("1")));
    await until(t.runner, "ended");
    expect(t.api.calls).toHaveLength(3);
    expect(t.api.calls[0]!.headers).toEqual({ "Content-Type": "application/json", [PASS_HEADER]: "pass-1" });
    for (const c of t.api.calls.slice(1)) {
      expect(c.headers).toEqual({ "Content-Type": "application/json", [PASS_HEADER]: "pass-2" });
    }
  });

  it("without headers(): only Content-Type is sent", async () => {
    const t = setup(["END"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "ended");
    expect(t.api.calls[0]!.headers).toEqual({ "Content-Type": "application/json" });
  });

  // PIN: lead contract 2026-09-22 (Turnstile pass) — the UI switches on the exact string "unverified".
  it("401 → error 'unverified' with prefix intact; retryStep repeats the same step with fresh headers", async () => {
    let pass = "stale";
    const t = setup(["1", { status: 401, body: { error: "unverified" } }, "2", "END"], {
      headers: () => ({ [PASS_HEADER]: pass }),
    });
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "error");
    expect(t.runner.snapshot.error).toBe("unverified");
    expect(t.runner.snapshot.prefix).toBe("1");
    expect(t.runner.snapshot.steps).toHaveLength(1);
    pass = "fresh"; // the UI re-verifies, then retries
    t.runner.retryStep();
    await until(t.runner, "ended");
    expect(t.runner.snapshot.retries).toBe(1);
    expect(t.api.calls.map((c) => c.prefix)).toEqual(["", "1", "1", "12"]);
    expectPrefixesFollowChoices(t.api.calls);
    expect(t.api.calls.map((c) => c.headers[PASS_HEADER])).toEqual(["stale", "stale", "fresh", "fresh"]);
  });

  it("network error → error with the message", async () => {
    const t = setup([{ throws: new TypeError("Failed to fetch") }]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "error");
    expect(t.runner.snapshot.error).toBe("network: Failed to fetch");
  });

  it(`run-wide retry ceiling ${RUN_RETRY_CEILING}: the next retryStep stays in error without a request`, async () => {
    const fail = { status: 503, body: { error: "disabled" } };
    const t = setup([fail, fail, fail, fail, "1"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "error");
    for (let i = 1; i <= RUN_RETRY_CEILING; i++) {
      t.runner.retryStep();
      await vi.waitFor(() => expect(t.api.calls).toHaveLength(i + 1), { interval: 1 });
      await until(t.runner, "error");
      expect(t.runner.snapshot.retries).toBe(i);
    }
    const before = t.runner.snapshot;
    t.runner.retryStep();
    await flush();
    expect(t.runner.snapshot).toBe(before);
    expect(t.runner.snapshot.state).toBe("error");
    expect(t.api.calls).toHaveLength(RUN_RETRY_CEILING + 1);
  });

  it("cancel() aborts the in-flight fetch → cancelled, and a late reply changes nothing", async () => {
    const d = deferred();
    const t = setup(["1", { pending: d.pending }, "2"]);
    t.runner.start(DISPLAY, WIRE);
    await vi.waitFor(() => expect(t.api.calls).toHaveLength(2), { interval: 1 });
    t.runner.cancel();
    expect(t.runner.snapshot.state).toBe("cancelled");
    expect(t.api.calls[1]!.signal?.aborted).toBe(true);
    const cancelled = t.runner.snapshot;
    d.resolve(jsonResponse(200, answer("7"))); // the fake ignores abort: the late reply still arrives
    await flush();
    expect(t.runner.snapshot).toBe(cancelled);
    expect(t.runner.snapshot.prefix).toBe("1");
    expect(t.api.calls).toHaveLength(2);
  });

  it("a late response for a stale run id does not mutate the new run", async () => {
    const old = deferred();
    const t = setup([{ pending: old.pending }, "4", { pending: new Promise<Response>(() => {}) }]);
    t.runner.start("1 + 1", "1 + 1");
    await vi.waitFor(() => expect(t.api.calls).toHaveLength(1), { interval: 1 });
    const oldId = t.runner.snapshot.id;

    t.runner.start("2 + 2", "2 + 2"); // new run while the old fetch is pending
    await vi.waitFor(() => expect(t.api.calls).toHaveLength(3), { interval: 1 }); // "4", then parked
    const newRun = t.runner.snapshot;
    expect(newRun.id).not.toBe(oldId);
    expect(newRun.prefix).toBe("4");
    expect(t.api.calls[0]!.signal?.aborted).toBe(true);

    const changes = t.snapshots.length;
    old.resolve(jsonResponse(200, answer("9"))); // arrives late, for the old id
    await flush();
    expect(t.runner.snapshot).toBe(newRun);
    expect(t.snapshots).toHaveLength(changes);
    expect(t.runner.snapshot.expression.wire).toBe("2 + 2");
    expect(t.api.calls.slice(1).map((c) => c.expression)).toEqual(["2 + 2", "2 + 2"]);
    expect(t.api.calls.slice(1).map((c) => c.prefix)).toEqual(["", "4"]);
  });

  it("emits a fresh frozen snapshot on every change; earlier snapshots never change", async () => {
    const t = setup(["1", "2", "END"]);
    t.runner.start(DISPLAY, WIRE);
    await until(t.runner, "ended");
    expect(t.snapshots.map((s) => [s.state, s.prefix, s.steps.length])).toEqual([
      ["running", "", 0],
      ["running", "1", 1],
      ["running", "12", 2],
      ["ended", "12", 3],
    ]);
    for (const s of t.snapshots) {
      expect(Object.isFrozen(s)).toBe(true);
      expect(Object.isFrozen(s.steps)).toBe(true);
    }
    expect(new Set(t.snapshots.map((s) => s.steps)).size).toBe(t.snapshots.length); // arrays copied
  });

  it("start() freezes the expression: a later start with other text is a new run, not an edit", async () => {
    const t = setup(["1", "END"]);
    t.runner.start("√144", "sqrt(144)");
    await until(t.runner, "ended");
    expect(t.runner.snapshot.expression).toEqual({ display: "√144", wire: "sqrt(144)" });
    expect(t.api.calls.every((c) => c.expression === "sqrt(144)")).toBe(true);
  });
});
