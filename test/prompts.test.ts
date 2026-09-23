// The prompts the Worker sends come from prompts/jev-prompts.md via scripts/sync-prompts.mjs.
// PIN: owner 2026-09-22 — prompts are owner-editable markdown; worker/prompts.ts is generated and must match.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePrompts, render } from "../scripts/sync-prompts.mjs";
import { ACTIVE_PROMPT_ID, PROMPTS } from "../worker/prompts";
import { ACTIVE_PROMPT, PROMPT_A, buildRequest } from "../worker/jev";
import { OPTIONS } from "../shared/protocol";

const md = readFileSync(new URL("../prompts/jev-prompts.md", import.meta.url), "utf8");
const generated = readFileSync(new URL("../worker/prompts.ts", import.meta.url), "utf8");

describe("prompts/jev-prompts.md", () => {
  it("is what worker/prompts.ts was generated from (run `npm run prompts` after editing the md)", () => {
    expect(render(parsePrompts(md))).toBe(generated);
  });
  it("has exactly one active prompt and every prompt lists all 13 options", () => {
    const { active, prompts } = parsePrompts(md);
    expect(active).toBe(ACTIVE_PROMPT_ID);
    for (const p of Object.values(prompts)) expect(Object.keys(p.criteria).sort()).toEqual([...OPTIONS].sort());
    expect(Object.keys(PROMPTS)).toEqual(Object.keys(prompts));
  });
  it("buildRequest sends the active prompt with templates filled", () => {
    const req = buildRequest("typesafe-ai/jev", "347 * 29", "10");
    expect(req.questions.next_char.instructions).toBe(ACTIVE_PROMPT.instructions);
    expect(req.state).toEqual(ACTIVE_PROMPT.state("347 * 29", "10"));
    expect(Object.values(req.state).join(" ")).toContain("347 * 29");
    expect(Object.values(req.state).join(" ")).toContain("10");
    // PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
    // "347 * 29" has at least 4 digits and "10" has 2, so END is withheld; the other 12 carry the md criteria.
    expect(Object.keys(req.questions.next_char.criteria)).toEqual(OPTIONS.filter((o) => o !== "END"));
    for (const o of OPTIONS.filter((o) => o !== "END")) expect(req.questions.next_char.criteria[o]).toBe(ACTIVE_PROMPT.criteria[o]);
  });
  it("every prompt's state references both {expression} and {prefix}; the generator rejects one that does not", () => {
    const { prompts } = parsePrompts(md);
    for (const p of Object.values(prompts)) {
      const t = Object.values(p.state).join("\n");
      expect(t).toContain("{expression}");
      expect(t).toContain("{prefix}");
    }
    expect(() => parsePrompts(md.replaceAll("{prefix}", "{answer}"))).toThrow(/no state template uses \{prefix\}/);
  });
  it("A (the shipped prompt) and B (the Codex candidate) both exist; A is active", () => {
    expect(Object.keys(PROMPTS)).toEqual(expect.arrayContaining(["A", "B"]));
    expect(ACTIVE_PROMPT_ID).toBe("A");
    expect(PROMPT_A.instructions).toBe(PROMPTS["A"]!.instructions);
  });
  // Codex review 2026-09-22: a second "## A" section used to overwrite the active A silently and ship.
  it("generator rejects duplicate prompt ids, state keys and criteria options", () => {
    const bSection = md.slice(md.indexOf("## B"));
    expect(() => parsePrompts(md + "\n" + bSection)).toThrow(/duplicate prompt id: B/);
    expect(() => parsePrompts(md + "\n" + bSection.replace("## B", "## A"))).toThrow(/duplicate prompt id: A/);
    expect(() => parsePrompts(md.replace("digits_emitted: {prefix}", "digits_emitted: {prefix}\ndigits_emitted: x"))).toThrow(/duplicate state key digits_emitted/);
    expect(() => parsePrompts(md.replace("END:\n", "END:\nEND: again\n"))).toThrow(/duplicate criteria option END/);
  });
  it("generator rejects a prompt missing an option or two actives", () => {
    expect(() => parsePrompts(md.replace("END:\n\n## B", "\n## B"))).toThrow(/13 options/);
    expect(() => parsePrompts(md.replace("## B", "## B (active)"))).toThrow(/two active/);
  });
});
