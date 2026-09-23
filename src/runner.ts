// Run controller: the autoregressive loop around Jev. Browser-owned state machine.
// Design: docs/260922-plan-jev-calculator.md §3.3. Implemented by the logic worker; UI renders snapshots only.
import { MAX_PREFIX, OPTIONS, type NextResponse, type Option } from "../shared/protocol";

export type RunState = "idle" | "running" | "paused" | "ended" | "capped" | "cancelled" | "error";

export interface Step extends NextResponse {
  index: number; // 0-based step
  client_ms: number; // browser-measured round trip
}

export interface RunSnapshot {
  id: number; // run identity; stale responses are ignored
  expression: { display: string; wire: string };
  prefix: string; // emitted so far (END never appended)
  steps: readonly Step[];
  state: RunState;
  /** paused: epoch ms when Resume becomes available */
  pausedUntil?: number;
  /** error: last error code/message */
  error?: string;
  retries: number; // run-wide transient retries used (ceiling 3)
}

export interface RunnerOptions {
  onChange: (snapshot: RunSnapshot) => void;
  fetch?: typeof fetch; // injectable for tests
  now?: () => number;
  endpoint?: string; // default "/api/next"
  /** Extra headers for every step (e.g. the Turnstile pass under PASS_HEADER); read per request. */
  headers?: () => Record<string, string>;
}

const DEFAULT_RETRY_AFTER_S = 60;

function freeze(s: RunSnapshot): RunSnapshot {
  return Object.freeze({ ...s, expression: Object.freeze({ ...s.expression }), steps: Object.freeze([...s.steps]) });
}

export class Runner {
  private readonly onChange: (snapshot: RunSnapshot) => void;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly endpoint: string;
  private readonly headers: () => Record<string, string>;
  private snap: RunSnapshot;
  private lastId = 0;
  private inflight: AbortController | null = null;

  constructor(opts: RunnerOptions) {
    this.onChange = opts.onChange;
    // Bound: calling an unbound window.fetch as a method throws "Illegal invocation".
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.endpoint = opts.endpoint ?? "/api/next";
    this.headers = opts.headers ?? (() => ({}));
    this.snap = freeze({ id: 0, expression: { display: "", wire: "" }, prefix: "", steps: [], state: "idle", retries: 0 });
  }

  get snapshot(): RunSnapshot {
    return this.snap;
  }

  /** Starts a new run (new id); cancels any active run. */
  start(display: string, wire: string): void {
    this.abortInflight();
    const id = ++this.lastId;
    this.set({ id, expression: { display, wire }, prefix: "", steps: [], state: "running", retries: 0 });
    void this.loop(id);
  }

  /** paused → running: repeats the same step. No-op unless paused and cooldown elapsed. */
  resume(): void {
    const s = this.snap;
    if (s.state !== "paused" || s.pausedUntil === undefined || this.now() < s.pausedUntil) return;
    this.set({ ...s, state: "running", pausedUntil: undefined });
    void this.loop(s.id);
  }

  /** error → running: retries the failed step (subject to retry ceiling). */
  retryStep(): void {
    const s = this.snap;
    if (s.state !== "error" || s.retries >= RUN_RETRY_CEILING) return;
    this.set({ ...s, state: "running", error: undefined, retries: s.retries + 1 });
    void this.loop(s.id);
  }

  cancel(): void {
    const s = this.snap;
    if (s.state !== "running" && s.state !== "paused" && s.state !== "error") return;
    this.abortInflight();
    this.set({ ...s, state: "cancelled", pausedUntil: undefined });
  }

  private set(next: RunSnapshot): void {
    // Drop undefined optionals so snapshots compare cleanly.
    const clean = { ...next };
    if (clean.pausedUntil === undefined) delete clean.pausedUntil;
    if (clean.error === undefined) delete clean.error;
    this.snap = freeze(clean);
    this.onChange(this.snap);
  }

  private abortInflight(): void {
    this.inflight?.abort();
    this.inflight = null;
  }

  /** True while run `id` is still the current, running run; guards every await. */
  private live(id: number): boolean {
    return this.snap.id === id && this.snap.state === "running";
  }

  private fail(id: number, error: string): void {
    if (this.live(id)) this.set({ ...this.snap, state: "error", error });
  }

  private async loop(id: number): Promise<void> {
    while (this.live(id)) {
      const { expression, prefix } = this.snap;
      const ctrl = new AbortController();
      this.inflight = ctrl;
      const t0 = this.now();
      let res: Response;
      let body: unknown;
      try {
        res = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.headers() },
          body: JSON.stringify({ expression: expression.wire, prefix }),
          signal: ctrl.signal,
        });
        body = await res.json().catch(() => undefined);
      } catch (e) {
        return this.fail(id, `network: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (this.inflight === ctrl) this.inflight = null;
      }
      if (!this.live(id)) return; // stale run, or cancelled while the request was in flight
      const clientMs = this.now() - t0;

      if (res.status === 429) {
        const s = retryAfterSeconds(body, res.headers.get("Retry-After"));
        this.set({ ...this.snap, state: "paused", pausedUntil: this.now() + s * 1000 });
        return;
      }
      // Missing/expired Turnstile pass: the UI switches on this exact string, re-verifies, then retryStep().
      if (res.status === 401) return this.fail(id, "unverified");
      if (!res.ok) {
        const code = isRecord(body) && typeof body.error === "string" ? body.error : "error";
        return this.fail(id, `http ${res.status}: ${code}`);
      }
      if (!isRecord(body) || typeof body.choice !== "string" || !OPTIONS.includes(body.choice as Option)) {
        return this.fail(id, "bad_response");
      }

      const index = this.snap.steps.length;
      const step: Step = { ...(body as unknown as NextResponse), index, client_ms: clientMs };
      const steps = [...this.snap.steps, step];
      if (step.choice === "END") {
        this.set({ ...this.snap, steps, state: "ended" });
        return;
      }
      const nextPrefix = prefix + step.choice; // verbatim, however malformed (§3.2)
      this.set({ ...this.snap, steps, prefix: nextPrefix, state: nextPrefix.length >= MAX_PREFIX ? "capped" : "running" });
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function retryAfterSeconds(body: unknown, header: string | null): number {
  if (isRecord(body) && typeof body.retry_after_s === "number" && body.retry_after_s > 0) return body.retry_after_s;
  const h = Number(header);
  return header !== null && Number.isFinite(h) && h > 0 ? h : DEFAULT_RETRY_AFTER_S;
}

export const RUN_RETRY_CEILING = 3;
export type { Option };
