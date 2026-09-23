// Model output grid: one column per emitted character. Shared row labels on the left, one pill per
// option whose colour intensity is the probability (fixed 0–1 scale), chosen row solid. Values as
// returned (2 dp). Design mock: docs/260922-ui-restyle-jev-calculator.md.
import { OPTIONS, type Option } from "../shared/protocol";
import type { RunSnapshot, Step } from "./runner";

const fmt2 = (x: number) => x.toFixed(2);

export interface GridOptions {
  ghost?: boolean;
  divergeAt?: number;
}

/** The whole "Model output" body for one run: header chips, pill grid, confidence row. */
export function renderGrid(run: RunSnapshot, opts: GridOptions = {}): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `grid-wrap ${opts.ghost ? "ghost" : "live"}`;
  wrap.setAttribute("aria-label", opts.ghost ? "Previous run" : "Current run");

  const pending = !opts.ghost && (run.state === "running" || run.state === "paused" || run.state === "error");
  const n = run.steps.length + (pending ? 1 : 0);
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.style.setProperty("--n", String(Math.max(n, 1)));

  // Row 0: empty corner + header chips
  grid.appendChild(cell("corner", ""));
  run.steps.forEach((s, i) => grid.appendChild(headChip(s, i === opts.divergeAt)));
  if (pending) grid.appendChild(pendingChip(run));

  // Rows 1..13: label + pills
  for (const opt of OPTIONS) {
    grid.appendChild(cell("row-label", opt === "END" ? "END" : opt));
    for (const s of run.steps) grid.appendChild(pill(opt, s.probabilities[opt] ?? 0, opt === s.choice));
    if (pending) grid.appendChild(pill(opt, 0, false, true));
  }

  // Confidence row
  grid.appendChild(cell("row-label conf-label", "Confidence"));
  for (const s of run.steps) {
    const c = cell("conf", fmt2(s.confidence)); // END included: the run score multiplies every step, so each factor is visible
    c.title = `Jev confidence ${fmt2(s.confidence)} · p(choice) ${fmt2(s.probabilities[s.choice] ?? 0)} · ${s.upstream_ms} ms via ${s.route}`;
    grid.appendChild(c);
  }
  if (pending) grid.appendChild(cell("conf", "…"));

  wrap.appendChild(grid);
  return wrap;
}

function cell(cls: string, text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

function headChip(step: Step, diverged: boolean): HTMLElement {
  const d = cell(`chip ${step.choice === "END" ? "end" : ""} ${diverged ? "diverge" : ""}`.trim(), step.choice);
  d.title = `step ${step.index + 1}${diverged ? " — runs diverge here" : ""}`;
  return d;
}

function pendingChip(run: RunSnapshot): HTMLElement {
  const d = cell(`chip pending ${run.state}`, run.state === "running" ? "…" : run.state === "paused" ? "⏸" : "⚠");
  d.title = run.state === "running" ? "asking Jev" : run.state === "paused" ? "rate limited — paused" : "failed";
  return d;
}

function pill(opt: Option, p: number, chosen: boolean, empty = false): HTMLElement {
  const d = document.createElement("div");
  d.className = `pill ${chosen ? "chosen" : ""} ${empty ? "empty" : ""}`.trim();
  d.style.setProperty("--p", String(Math.max(0, Math.min(1, p))));
  d.title = empty ? "" : `${opt}: ${fmt2(p)}`;
  return d;
}

/** Index of the first step where two runs chose differently, or undefined. */
export function firstDivergence(a: RunSnapshot, b: RunSnapshot): number | undefined {
  const n = Math.min(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) if (a.steps[i]!.choice !== b.steps[i]!.choice) return i;
  return a.steps.length !== b.steps.length ? n : undefined;
}
