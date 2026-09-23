// Page wiring: keypad → frozen expression → Runner → columns/run score/status. Rendering only; no arithmetic.
import { type Expression, type Key, isComplete, press, pressAfterRun, toDisplay, toWire } from "../shared/expression";
import { Keypad } from "./keypad";
import { firstDivergence, renderGrid } from "./columns";
import { Runner, type RunSnapshot } from "./runner";
import { formatSci, runScore } from "./score";
import { PASS_HEADER, type ConfigResponse, type PassResponse } from "../shared/protocol";

const app = document.getElementById("app")!;
app.innerHTML = `
  <header class="top">
    <div class="intro">
      <h1>Jev Calculator</h1>
      <p class="tagline">A probabilistic AI calculator powered by Jev.</p>
      <p class="lede">Type an expression, press =, and watch TypeSafe's Jev (a System One classifier) emit the result one character at a time, with the full probability distribution shown under each character.</p>
      <p class="links"><a class="gh" href="https://github.com/pc418/jev-calculator" target="_blank" rel="noopener"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Source on GitHub</a></p>
    </div>
    <aside class="callout" aria-label="Disclaimer">
      <strong>Fast Typesafe Calculator</strong>
      <span>These are model predictions, not computed answers. Enjoy the chaos!</span>
    </aside>
  </header>

  <div class="panels">
    <section class="card calc" aria-label="Calculator">
      <div class="display" aria-live="polite">
        <div class="expr" id="expr">0</div>
        <div class="result"><span id="answer" class="answer"></span><span id="terminal" class="terminal"></span></div>
      </div>
      <div id="keypad-slot"></div>
      <button id="rerun" type="button" class="btn rerun" hidden title="Same expression again — identical calls return jittery probabilities">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        Rerun
      </button>
    </section>

    <section class="card output" aria-label="Model output">
      <div class="output-head">
        <h2>Model output <span class="muted">(streaming)</span></h2>
        <div class="status">
          <span id="state" class="state">idle</span>
          <span id="countdown" class="countdown"></span>
          <button id="resume" type="button" class="btn small" hidden>Resume</button>
          <button id="retry" type="button" class="btn small" hidden>Retry step</button>
          <button id="cancel" type="button" class="btn small" hidden>Cancel</button>
        </div>
      </div>
      <div id="turnstile" class="turnstile" aria-label="Bot check"></div>
      <div id="runs" class="runs"><p class="empty">Enter an expression and press = to start.</p></div>
      <p id="divnote" class="note" hidden></p>
      <div class="stats">
        <div class="stat">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <div><span class="stat-label">Latency (last call)</span><span id="latency" class="stat-value">–</span></div>
        </div>
        <div class="stat">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19h16"/><path d="M6 15l4-6 4 3 4-7"/></svg>
          <div><span class="stat-label">Run score <span class="muted">(∏ confidence)</span></span><span id="score" class="stat-value">–</span></div>
        </div>
      </div>
      <details class="details"><summary>Run details</summary><div id="details"></div></details>
    </section>
  </div>

  <section class="about" aria-label="About this demo">
    <div>
      <h2>About this demo</h2>
      <p>This page calls TypeSafe's Jev model via the Vercel AI Gateway, hosted on Cloudflare. It's just a display page: we do not compute or show the true answer, and we don't check correctness.</p>
      <p>Public and free (with rate limiting). All 13 options are offered every step; whatever Jev picks is appended, mistakes included. “Confidence” is the API's spread statistic, not the chance a digit is right.</p>
    </div>
    <div class="scope">
      <h3>Out of scope (by design)</h3>
      <ul>
        <li>Computing or showing the true answer</li>
        <li>Showing a correctness diff</li>
      </ul>
    </div>
  </section>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const exprEl = $("expr"), answerEl = $("answer"), terminalEl = $("terminal");
const stateEl = $("state"), countdownEl = $("countdown");
const resumeBtn = $<HTMLButtonElement>("resume"), retryBtn = $<HTMLButtonElement>("retry");
const cancelBtn = $<HTMLButtonElement>("cancel"), rerunBtn = $<HTMLButtonElement>("rerun");
const runsEl = $("runs"), scoreEl = $("score"), divNote = $("divnote"), detailsEl = $("details"), latencyEl = $("latency");

let expr: Expression = [];
let previous: RunSnapshot | null = null; // ghost of the last finished run of the same expression
let snap: RunSnapshot | null = null;

// ---- Bot check (Cloudflare Turnstile → short-lived pass sent on every /api/next) ----
declare global {
  interface Window { onTurnstileLoad?: () => void; turnstile?: Turnstile }
}
interface Turnstile {
  render(el: string | HTMLElement, opts: Record<string, unknown>): string;
  execute(el: string | HTMLElement): void;
  reset(id?: string): void;
}
/** "unknown" until /api/config answered; null = the server said verification is off. */
let sitekey: string | null | "unknown" = "unknown";
let pass: { value: string; exp: number } | null = null;
let widgetId: string | null = null;
let tokenWaiters: Array<(t: string | null) => void> = [];
const CHECK_TIMEOUT_MS = 20_000;

const turnstileReady = new Promise<void>((resolve) => {
  if (window.turnstile) resolve();
  else window.onTurnstileLoad = () => resolve();
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { window.clearTimeout(t); resolve(v); }, (e) => { window.clearTimeout(t); reject(e); });
  });
}

/** Loads /api/config; a network/5xx failure leaves the state "unknown" so the next start retries it. */
async function loadConfig(): Promise<void> {
  try {
    const c = await withTimeout(
      fetch("/api/config").then((r) => (r.ok ? (r.json() as Promise<ConfigResponse>) : null)),
      CHECK_TIMEOUT_MS,
      "config",
    );
    if (c) sitekey = c.turnstile_sitekey;
  } catch {
    /* stays "unknown" */
  }
}
const configLoaded = loadConfig();

async function ensureWidget(): Promise<void> {
  if (widgetId !== null || sitekey === null || sitekey === "unknown") return;
  await withTimeout(turnstileReady, CHECK_TIMEOUT_MS, "bot-check script");
  widgetId = window.turnstile!.render("#turnstile", {
    sitekey,
    action: "solve",
    execution: "execute",
    appearance: "interaction-only",
    theme: "auto",
    callback: (token: string) => { const w = tokenWaiters; tokenWaiters = []; w.forEach((f) => f(token)); },
    "error-callback": () => { const w = tokenWaiters; tokenWaiters = []; w.forEach((f) => f(null)); },
    "expired-callback": () => {},
  });
}

/** One solve at a time: a `=` click during the page-load prefetch awaits this instead of executing Turnstile again. */
let passInflight: { promise: Promise<boolean>; quiet: boolean } | null = null;

/**
 * Resolves true once a valid pass is held (or verification is off). Returns at once while the pass has
 * more than 30 s left; otherwise joins the in-flight solve or starts one. `quiet` (the page-load prefetch)
 * writes nothing to the status line; when a click joined a quiet solve that failed, it tries again loudly.
 */
async function ensurePass(quiet = false): Promise<boolean> {
  for (;;) {
    if (pass && pass.exp - 30_000 > Date.now()) return true;
    const shared = passInflight;
    if (shared === null) break;
    if (!quiet) setStatus("checking you are human…");
    const ok = await shared.promise;
    if (ok || quiet || !shared.quiet) return ok;
  }
  const promise: Promise<boolean> = acquirePass(quiet).finally(() => {
    if (passInflight?.promise === promise) passInflight = null;
  });
  passInflight = { promise, quiet };
  return promise;
}

/** Page load: solve the bot check in the background so `=` does not wait for it. Failures are left to the click. */
async function prefetchPass(): Promise<void> {
  await configLoaded;
  if (sitekey === null || sitekey === "unknown") return;
  await ensurePass(true);
}

/** Solve (usually invisibly) and exchange the token for a pass. Resolves false when the check fails. */
async function acquirePass(quiet: boolean): Promise<boolean> {
  const say = (text: string) => { if (!quiet) setStatus(text); };
  await configLoaded;
  if (sitekey === "unknown") await loadConfig();
  if (sitekey === "unknown") { say("cannot reach the server — try again"); return false; }
  if (sitekey === null) return true; // verification disabled server-side
  if (pass && pass.exp - 30_000 > Date.now()) return true;
  say("checking you are human…");
  try {
    await ensureWidget();
    const token = await withTimeout(
      new Promise<string | null>((resolve) => {
        tokenWaiters.push(resolve);
        window.turnstile!.reset(widgetId!);
        window.turnstile!.execute("#turnstile");
      }),
      CHECK_TIMEOUT_MS,
      "bot check",
    );
    if (!token) { say("bot check failed — try again"); return false; }
    const body = await withTimeout(
      fetch("/api/pass", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      }).then((res) => (res.ok ? (res.json() as Promise<PassResponse>) : null)),
      CHECK_TIMEOUT_MS,
      "pass exchange",
    );
    if (!body) { say("bot check rejected — try again"); return false; }
    pass = { value: body.pass, exp: Date.now() + body.expires_in * 1000 };
    return true;
  } catch (e) {
    tokenWaiters = []; // nobody is listening any more; a late token is dropped
    say(`${e instanceof Error ? e.message : "bot check failed"} — try again`);
    return false;
  }
}

function setStatus(text: string) { stateEl.textContent = text; }

void prefetchPass();

const runner = new Runner({
  onChange: (s) => { snap = s; render(); },
  headers: (): Record<string, string> => (pass ? { [PASS_HEADER]: pass.value } : {}),
});

const keypad = new Keypad({
  onKey: (key: Key) => {
    if (isLocked()) return;
    // After a finished run (any terminal state) a digit starts a new expression instead of appending.
    const afterRun = snap !== null && !isBusy();
    const next = afterRun ? pressAfterRun(expr, key) : press(expr, key);
    if (next === null) return;
    expr = next;
    // Editing starts a new experiment: drop the finished run's columns, ghost and Rerun target.
    previous = null;
    snap = null;
    render();
  },
  onEquals: () => {
    if (!isComplete(expr) || isLocked()) return;
    previous = null;
    void startChecked(toDisplay(expr), toWire(expr));
  },
});
$("keypad-slot").appendChild(keypad.el);

rerunBtn.addEventListener("click", () => {
  if (!snap || isLocked()) return;
  previous = snap;
  void startChecked(snap.expression.display, snap.expression.wire);
});

let starting = false;
let recoveriesForRun = { id: -1, n: 0 };
async function startChecked(display: string, wire: string) {
  if (starting) return;
  starting = true;
  syncLock(); // Codex 2026-09-22: keys stay locked while the start waits for the bot check, so an edit cannot outrun it
  try {
    if (await ensurePass()) runner.start(display, wire);
  } finally {
    starting = false;
    syncLock();
  }
}

/** The server rejected our pass (expired or rotated): solve again and repeat the step. */
async function recoverUnverified() {
  pass = null;
  if (await ensurePass()) runner.retryStep();
}
resumeBtn.addEventListener("click", () => runner.resume());
retryBtn.addEventListener("click", () => runner.retryStep());
cancelBtn.addEventListener("click", () => runner.cancel());

function isBusy() {
  return snap?.state === "running" || snap?.state === "paused";
}
/** Busy, or a start / 401 recovery is waiting for the bot check: no edits, no Rerun, no manual Retry meanwhile. */
function isLocked() {
  return isBusy() || starting;
}
/** Keys, Rerun and Retry follow the lock; called from render() and whenever `starting` flips without a snapshot change. */
function syncLock() {
  keypad.update(expr, isLocked(), snap !== null && !isBusy());
  rerunBtn.hidden = isLocked() || !snap || snap.steps.length === 0;
  // Codex 2026-09-22: a manual Retry during the automatic 401 recovery would send without a pass and burn the retry ceiling.
  retryBtn.hidden = !snap || snap.state !== "error" || starting;
}

let ticker: number | undefined;
function render() {
  const busy = isBusy();
  exprEl.textContent = busy ? snap!.expression.display : expr.length ? toDisplay(expr) : "0";
  syncLock();

  if (!snap) {
    answerEl.textContent = "";
    terminalEl.textContent = "";
    stateEl.textContent = "idle";
    countdownEl.textContent = "";
    window.clearInterval(ticker);
    resumeBtn.hidden = retryBtn.hidden = cancelBtn.hidden = rerunBtn.hidden = true;
    runsEl.innerHTML = '<p class="empty">Enter an expression and press = to start.</p>';
    scoreEl.textContent = "–";
    scoreEl.title = "";
    latencyEl.textContent = "–";
    divNote.hidden = true;
    detailsEl.innerHTML = "";
    return;
  }
  if (snap.state === "error" && snap.error === "unverified" && !starting) {
    if (recoveriesForRun.id !== snap.id) recoveriesForRun = { id: snap.id, n: 0 };
    if (recoveriesForRun.n < 2) {
      recoveriesForRun.n += 1;
      starting = true;
      syncLock();
      // render(): a second attempt if allowed, else the "keeps failing" label with Retry visible again.
      void recoverUnverified().finally(() => { starting = false; render(); });
    }
  }
  answerEl.textContent = snap.prefix;
  terminalEl.textContent = terminalLabel(snap);
  terminalEl.dataset.state = snap.state;
  stateEl.textContent = stateLabel(snap);

  resumeBtn.hidden = snap.state !== "paused";
  cancelBtn.hidden = !busy;

  window.clearInterval(ticker);
  countdownEl.textContent = "";
  if (snap.state === "paused") {
    const tick = () => {
      const left = Math.max(0, Math.ceil(((snap?.pausedUntil ?? 0) - Date.now()) / 1000));
      countdownEl.textContent = left > 0 ? `resume in ${left}s` : "cooldown over";
      resumeBtn.disabled = left > 0;
    };
    tick();
    ticker = window.setInterval(tick, 250);
  }

  const divergeAt = previous ? firstDivergence(snap, previous) : undefined;
  runsEl.replaceChildren(renderGrid(snap, { divergeAt }));
  if (previous) {
    const cap = document.createElement("p");
    cap.className = "ghost-cap";
    cap.textContent = "Previous run";
    runsEl.append(cap, renderGrid(previous, { ghost: true, divergeAt }));
  }
  const last = snap.steps[snap.steps.length - 1];
  latencyEl.textContent = last ? `${last.upstream_ms} ms` : "–";
  divNote.hidden = !previous;
  if (previous) {
    divNote.textContent = divergeAt === undefined
      ? "Rerun matched the previous run character for character. Differences in the bars are identical-input jitter."
      : `Runs diverged at step ${divergeAt + 1}. Columns before it compare identical inputs; from there on the prefixes differ, so the bars answer different questions.`;
  }
  const score = runScore(snap.steps);
  scoreEl.textContent = score === null ? "–" : formatSci(score);
  scoreEl.title = score === null ? "" : `product of the per-step Jev confidences over ${snap.steps.length} step(s), END step included`;
  runsEl.querySelector(".grid-wrap.live")?.scrollTo({ left: 1e6 });
  renderDetails(snap);
}

function terminalLabel(s: RunSnapshot): string {
  switch (s.state) {
    case "ended": return "";
    case "capped": return "TRUNCATED";
    case "cancelled": return "CANCELLED";
    case "error": return "ERROR";
    case "paused": return "⏸";
    case "running": return "▌";
    default: return "";
  }
}

function stateLabel(s: RunSnapshot): string {
  switch (s.state) {
    case "running": return `asking Jev — step ${s.steps.length + 1}`;
    case "paused": return "rate limited by the gateway (30 req/min for everyone). Paused; the prefix is kept.";
    case "ended": return `done — Jev said END after ${s.steps.length - 1} character${s.steps.length === 2 ? "" : "s"}`;
    case "capped": return `stopped at ${s.prefix.length} characters (cap) — truncated, not complete`;
    case "cancelled": return "cancelled";
    case "error":
      // Codex re-verify 2026-09-22: tied to `starting`, not the attempt count, so the second attempt does not read "keeps failing" while it still solves.
      if (s.error === "unverified") return starting ? "re-checking you are human…" : "bot check keeps failing — reload the page";
      return `failed: ${s.error ?? "unknown error"} (retries used ${s.retries}/3)`;
    default: return "idle";
  }
}

function renderDetails(s: RunSnapshot) {
  const sum = (k: "cost" | "market_cost") => s.steps.reduce((a, st) => a + (parseFloat(st[k]) || 0), 0);
  const tokens = s.steps.reduce((a, st) => a + st.usage.input_tokens, 0);
  const rows = s.steps.map((st) =>
    `<tr><td>${st.index + 1}</td><td>${st.choice}</td><td>${st.confidence.toFixed(2)}</td><td>${st.route}</td><td>${st.model}</td><td>${st.upstream_ms}</td><td>${st.client_ms}</td><td>${st.usage.input_tokens}</td><td>${st.market_cost}</td><td><code>${st.generation_id}</code></td></tr>`,
  ).join("");
  detailsEl.innerHTML = `
    <p>run #${s.id} · state <b>${s.state}</b> · wire <code>${escapeHtml(s.expression.wire)}</code> · input tokens ${tokens} · market cost $${sum("market_cost").toFixed(6)} · billed $${sum("cost").toFixed(6)}</p>
    <table class="steps"><thead><tr><th>#</th><th>choice</th><th>conf</th><th>route</th><th>model</th><th>upstream ms</th><th>browser ms</th><th>in tok</th><th>market $</th><th>generation</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

render();
