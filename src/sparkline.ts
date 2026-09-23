// Jev confidence per step as an inline SVG line. Fixed 0–1 scale; one series, so no legend.
import type { Step } from "./runner";

export function renderSparkline(steps: readonly Step[], ghost?: readonly Step[]): SVGSVGElement {
  const W = 260, H = 40, PAD = 6;
  const n = Math.max(steps.length, ghost?.length ?? 0, 2);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (n - 1);
  const y = (c: number) => H - PAD - c * (H - 2 * PAD);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Jev confidence per step");

  for (const g of [0, 0.5, 1]) {
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", String(PAD)); line.setAttribute("x2", String(W - PAD));
    line.setAttribute("y1", String(y(g))); line.setAttribute("y2", String(y(g)));
    line.setAttribute("class", "grid");
    svg.appendChild(line);
  }
  const series = (s: readonly Step[], cls: string) => {
    if (s.length === 0) return;
    const pl = document.createElementNS(svg.namespaceURI, "polyline");
    pl.setAttribute("points", s.map((st, i) => `${x(i)},${y(st.confidence)}`).join(" "));
    pl.setAttribute("class", `line ${cls}`);
    svg.appendChild(pl);
    s.forEach((st, i) => {
      const c = document.createElementNS(svg.namespaceURI, "circle");
      c.setAttribute("cx", String(x(i))); c.setAttribute("cy", String(y(st.confidence))); c.setAttribute("r", "3.5");
      c.setAttribute("class", `dot ${cls}`);
      const t = document.createElementNS(svg.namespaceURI, "title");
      t.textContent = `step ${i + 1} (${st.choice}): confidence ${st.confidence.toFixed(2)}`;
      c.appendChild(t);
      svg.appendChild(c);
    });
  };
  if (ghost) series(ghost, "ghost");
  series(steps, "live");
  return svg;
}
