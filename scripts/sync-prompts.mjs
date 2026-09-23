// Generates worker/prompts.ts from prompts/jev-prompts.md. Strict: any format slip fails the build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "prompts", "jev-prompts.md");
const out = join(root, "worker", "prompts.ts");
const OPTIONS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-", "END"];

export function parsePrompts(md) {
  const prompts = {};
  let active = null;
  const sections = md.split(/^## /m).slice(1);
  if (sections.length === 0) throw new Error("no '## <ID>' sections");
  for (const sec of sections) {
    const [head, ...rest] = sec.split("\n");
    const m = /^([A-Za-z0-9_-]+)\s*(\(active\))?\s*$/.exec(head.trim());
    if (!m) throw new Error(`bad section header: "## ${head}"`);
    const id = m[1];
    if (id in prompts) throw new Error(`duplicate prompt id: ${id}`);
    if (m[2]) {
      if (active) throw new Error(`two active prompts: ${active} and ${id}`);
      active = id;
    }
    const body = rest.join("\n");
    const part = (name) => {
      const r = new RegExp(`^### ${name}\\s*\\n([\\s\\S]*?)(?=^### |$(?![\\r\\n]))`, "m").exec(body);
      if (!r) throw new Error(`prompt ${id}: missing '### ${name}'`);
      return r[1].trim();
    };
    const state = {};
    for (const line of part("state").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (!kv) throw new Error(`prompt ${id}: bad state line "${line}"`);
      if (kv[1] in state) throw new Error(`prompt ${id}: duplicate state key ${kv[1]}`);
      state[kv[1]] = kv[2];
    }
    if (Object.keys(state).length === 0) throw new Error(`prompt ${id}: empty state`);
    const templates = Object.values(state).join("\n");
    for (const ph of ["{expression}", "{prefix}"]) {
      if (!templates.includes(ph)) throw new Error(`prompt ${id}: no state template uses ${ph}`);
    }
    const instructions = part("instructions").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    if (!instructions) throw new Error(`prompt ${id}: empty instructions`);
    const criteria = {};
    for (const line of part("criteria").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const kv = /^(END|[0-9.-]):\s*(.*)$/.exec(line);
      if (!kv) throw new Error(`prompt ${id}: bad criteria line "${line}"`);
      if (kv[1] in criteria) throw new Error(`prompt ${id}: duplicate criteria option ${kv[1]}`);
      criteria[kv[1]] = kv[2] === "" ? null : kv[2];
    }
    const missing = OPTIONS.filter((o) => !(o in criteria));
    const extra = Object.keys(criteria).filter((o) => !OPTIONS.includes(o));
    if (missing.length || extra.length) throw new Error(`prompt ${id}: criteria must list exactly the 13 options (missing ${missing.join(",") || "-"}; extra ${extra.join(",") || "-"})`);
    prompts[id] = { state, instructions, criteria };
  }
  if (!active) throw new Error("no prompt marked (active)");
  return { active, prompts };
}

export function render({ active, prompts }) {
  const lines = [
    "// GENERATED from prompts/jev-prompts.md by scripts/sync-prompts.mjs — edit the .md, then `npm run prompts`.",
    "// Every LLM-facing string the Worker sends lives here. No conditional pieces: the body is identical every step.",
    'import type { Option } from "../shared/protocol";',
    "",
    "export type Criteria = Record<Option, string | null>;",
    "",
    "export interface PromptSpec {",
    "  /** state templates: {expression} = wire expression, {prefix} = answer so far */",
    "  state: Record<string, string>;",
    "  instructions: string;",
    "  criteria: Criteria;",
    "}",
    "",
    `export const ACTIVE_PROMPT_ID = ${JSON.stringify(active)};`,
    "",
    `export const PROMPTS: Record<string, PromptSpec> = ${JSON.stringify(prompts, null, 2)};`,
    "",
  ];
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parsePrompts(readFileSync(src, "utf8"));
  const code = render(parsed);
  const check = process.argv.includes("--check");
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* first run */ }
  if (check) {
    if (current !== code) { console.error("worker/prompts.ts is out of date — run `npm run prompts`"); process.exit(1); }
    console.log("prompts in sync");
  } else if (current !== code) {
    writeFileSync(out, code);
    console.log(`wrote ${out} (active: ${parsed.active}; prompts: ${Object.keys(parsed.prompts).join(", ")})`);
  }
}
