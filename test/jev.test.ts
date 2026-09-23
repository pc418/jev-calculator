import { describe, expect, it } from "vitest";
import { OPTIONS } from "../shared/protocol";
import { ACTIVE_PROMPT, JevResponseError, PROMPT_A, PROMPT_B, buildRequest, mapResponse, toPrompt } from "../worker/jev";
import { expectedRequest } from "./helpers/expected-request";
import recordedRequest from "./fixtures/gateway-request.recorded.json";
import recorded12 from "./fixtures/gateway-response.recorded.json";
import response13 from "./fixtures/gateway-response.13opt.json";
import tie from "./fixtures/gateway-response.tie.json";
import direct from "./fixtures/direct-response.recorded.json";

const MODEL = "typesafe-ai/jev";
const clone = <T>(v: T): T => structuredClone(v);

describe("buildRequest (active prompt from prompts/jev-prompts.md)", () => {
  // PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
  it("equals the body derived from the active prompt, all criteria offered in OPTIONS order for a non-product", () => {
    const body = buildRequest(MODEL, "12 + 3", "1");
    expect(body).toEqual(expectedRequest(MODEL, "12 + 3", "1"));
    // Key order is part of the byte-stable body.
    expect(Object.keys(body.questions.next_char.criteria)).toEqual([...OPTIONS]);
    // No masking on prefix shape: a prefix that already has "-" and "." still offers both.
    const odd = buildRequest(MODEL, "3 - 5", "-1.2.");
    expect(Object.keys(odd.questions.next_char.criteria)).toEqual([...OPTIONS]);
    expect(odd.state).toEqual(ACTIVE_PROMPT.state("3 - 5", "-1.2."));
    // Templates really are filled: the wire expression and the verbatim prefix reach the state.
    const joined = Object.values(odd.state).join("\n");
    expect(joined).toContain("3 - 5");
    expect(joined).toContain("-1.2.");
    expect(joined).not.toContain("{");
  });

  // PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
  it("withholds END's criterion for '123 * 45' until 4 digits are emitted; everything else identical", () => {
    const withheld = buildRequest(MODEL, "123 * 45", "");
    const noEnd = OPTIONS.filter((o) => o !== "END");
    expect(Object.keys(withheld.questions.next_char.criteria)).toEqual(noEnd);
    expect(withheld).toEqual(expectedRequest(MODEL, "123 * 45", ""));
    // Same body as a full 13-option one apart from the missing END criterion: state, instructions, model.
    const full = buildRequest(MODEL, "123 * 45", "5555");
    expect(Object.keys(full.questions.next_char.criteria)).toEqual([...OPTIONS]);
    const { END: _end, ...fullMinusEnd } = full.questions.next_char.criteria;
    expect(withheld.questions.next_char.criteria).toEqual(fullMinusEnd);
    for (const o of noEnd) expect(withheld.questions.next_char.criteria[o]).toBe(ACTIVE_PROMPT.criteria[o]);
    expect(withheld.questions.next_char.instructions).toBe(full.questions.next_char.instructions);
    expect(withheld.state).toEqual(ACTIVE_PROMPT.state("123 * 45", ""));
    expect(withheld.model).toBe(full.model);
    // 3 digits (signs/dots ignored) still withholds; a sum never does.
    expect(Object.keys(buildRequest(MODEL, "123 * 45", "-5.55").questions.next_char.criteria)).toEqual(noEnd);
    for (const prefix of ["", "1", "15"]) {
      expect(Object.keys(buildRequest(MODEL, "12 + 3", prefix).questions.next_char.criteria)).toEqual([...OPTIONS]);
    }
  });

  it("offers the recorded (12-option) probe's criteria plus the '-' option", () => {
    const body = buildRequest(MODEL, "12 + 3", "1");
    expect(Object.keys(body.questions.next_char.criteria)).toEqual([...Object.keys(recordedRequest.questions.next_char.criteria), "-"].sort((a, b) => OPTIONS.indexOf(a as never) - OPTIONS.indexOf(b as never)));
    expect(body.model).toBe(recordedRequest.model);
  });

  it("takes the model from its argument (JEV_MODEL or TYPESAFE_MODEL)", () => {
    expect(buildRequest("typesafe-ai/jev-latest", "1", "").model).toBe("typesafe-ai/jev-latest");
    // The direct route's body is the gateway body with only `model` swapped.
    expect(buildRequest("jev-latest", "12 + 3", "1")).toEqual({ ...expectedRequest(MODEL, "12 + 3", "1"), model: "jev-latest" });
  });

  it("toPrompt fills every {expression}/{prefix} occurrence per state key and keeps criteria as given", () => {
    const p = toPrompt("T", {
      state: { a: "{expression} = {prefix}", b: "{prefix}{prefix}", c: "plain" },
      instructions: "x",
      criteria: { ...PROMPT_A.criteria, END: "done" },
    });
    expect(p.id).toBe("T");
    expect(p.state("12 + 3", "1")).toEqual({ a: "12 + 3 = 1", b: "11", c: "plain" });
    expect(p.criteria.END).toBe("done");
    expect(p.criteria["0"]).toBeNull();
  });

  it("PROMPT_A / PROMPT_B are the md prompts by id; A is the active one shipped", () => {
    expect(PROMPT_A.id).toBe("A");
    expect(PROMPT_B.id).toBe("B");
    expect(ACTIVE_PROMPT.id).toBe("A");
    expect(Object.keys(PROMPT_B.criteria)).toEqual([...OPTIONS]);
  });
});

describe("mapResponse", () => {
  it("maps the recorded response (13-option derivation): rounding and metadata passthrough", () => {
    const m = mapResponse(clone(response13));
    expect(m).toEqual({
      choice: "5",
      confidence: 0.73,
      probabilities: {
        "0": 0, "1": 0.14, "2": 0.01, "3": 0.02, "4": 0.02, "5": 0.76, "6": 0, "7": 0.01, "8": 0.01, "9": 0.03,
        ".": 0, "-": 0, END: 0,
      },
      withheld: [],
      usage: { input_tokens: 378, output_tokens: 102 },
      cost: "0",
      market_cost: "0.000015876",
      generation_id: "gen_01M35JG6980Y50PYPKNGBM2A61",
      model: "typesafe-ai/jev",
    });
    expect(Object.keys(m.probabilities)).toEqual([...OPTIONS]);
  });

  it("maps the direct-API response: served model version passes through, no gateway metadata → empty cost fields", () => {
    expect(mapResponse(clone(direct))).toEqual({
      choice: "5",
      confidence: 0.81,
      probabilities: {
        "0": 0, "1": 0.09, "2": 0.01, "3": 0.02, "4": 0.01, "5": 0.82, "6": 0, "7": 0.01, "8": 0.01, "9": 0.03,
        ".": 0, "-": 0, END: 0,
      },
      withheld: [],
      usage: { input_tokens: 378, output_tokens: 102 },
      cost: "",
      market_cost: "",
      generation_id: "",
      model: "jev-1.13.0",
    });
  });

  it.each([
    ["absent", undefined],
    ["not a string", 13],
  ])("model %s → ''", (_name, value) => {
    const r: Record<string, unknown> = clone(direct);
    if (value === undefined) delete r.model;
    else r.model = value;
    expect(mapResponse(r).model).toBe("");
  });

  it("existing gateway fixtures still echo model typesafe-ai/jev", () => {
    expect(mapResponse(clone(tie)).model).toBe("typesafe-ai/jev");
  });

  it("re-rounds float noise like 0.41000000000000003 to 2 dp and never renormalises", () => {
    const r = clone(response13);
    r.answers.next_char.probabilities["1"] = 0.41000000000000003;
    expect(0.41000000000000003).not.toBe(0.41);
    const m = mapResponse(r);
    expect(m.probabilities["1"]).toBe(0.41);
    const sum = Object.values(m.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.27, 10); // as returned (0.14 → 0.41 pushes the sum past 1), not forced to 1
  });

  // PIN: owner 2026-09-22 — all 13 options offered every step EXCEPT END for pure integer products before the minimum digit count ("hide end before expected least digits … for mult"); docs/260922-feat-withhold-end-mult.md
  it("tie fixture: two options round equal and the API chose the later-listed one → choice is the API's", () => {
    const m = mapResponse(clone(tie));
    expect(m.probabilities["3"]).toBe(0.41);
    expect(m.probabilities["7"]).toBe(0.41);
    expect(m.choice).toBe("7");
  });

  it("defaults generation_id/cost/market_cost to '' when gateway metadata is absent (direct API)", () => {
    const r: Record<string, unknown> = clone(response13);
    delete r.provider_metadata;
    const m = mapResponse(r);
    expect([m.cost, m.market_cost, m.generation_id]).toEqual(["", "", ""]);
  });

  it("rejects the raw 12-option recorded response (missing '-')", () => {
    expect(() => mapResponse(clone(recorded12))).toThrow(JevResponseError);
  });

  describe("with END withheld (offered = 12 options)", () => {
    const offered = OPTIONS.filter((o) => o !== "END");
    const withoutEnd = () => {
      const r = clone(response13) as any;
      delete r.answers.next_char.probabilities.END;
      return r;
    };

    it("accepts a response lacking END: END probability 0, withheld ['END'], other fields as the 13-option mapping", () => {
      const m = mapResponse(withoutEnd(), offered);
      expect(m.probabilities.END).toBe(0);
      expect(m.withheld).toEqual(["END"]);
      expect(Object.keys(m.probabilities)).toEqual([...OPTIONS]);
      const full = mapResponse(clone(response13));
      expect(m).toEqual({ ...full, withheld: ["END"] }); // fixture's END is 0 anyway
    });

    it("rejects a response that includes the withheld END", () => {
      expect(() => mapResponse(clone(response13), offered)).toThrow(JevResponseError);
    });

    it("rejects choice END while it is withheld", () => {
      const r = withoutEnd();
      r.answers.next_char.choice = "END";
      expect(() => mapResponse(r, offered)).toThrow(JevResponseError);
    });

    it("still rejects a missing offered option", () => {
      const r = withoutEnd();
      delete r.answers.next_char.probabilities["9"];
      expect(() => mapResponse(r, offered)).toThrow(JevResponseError);
    });
  });

  it("default mapping reports withheld [] on every 13-option fixture", () => {
    for (const f of [response13, tie, direct]) expect(mapResponse(clone(f)).withheld).toEqual([]);
  });

  const mutations: Array<[string, (r: any) => void]> = [
    ["missing option", (r) => delete r.answers.next_char.probabilities["9"]],
    ["unknown option", (r) => (r.answers.next_char.probabilities["+"] = 0)],
    ["unknown choice", (r) => (r.answers.next_char.choice = "+")],
    ["choice missing", (r) => delete r.answers.next_char.choice],
    ["value 1.2", (r) => (r.answers.next_char.probabilities["5"] = 1.2)],
    ["negative value", (r) => (r.answers.next_char.probabilities["5"] = -0.1)],
    ["non-numeric value", (r) => (r.answers.next_char.probabilities["5"] = "0.76")],
    ["NaN-like null value", (r) => (r.answers.next_char.probabilities["5"] = null)],
    ["confidence 1.5", (r) => (r.answers.next_char.confidence = 1.5)],
    ["confidence missing", (r) => delete r.answers.next_char.confidence],
    ["type not choice", (r) => (r.answers.next_char.type = "boolean")],
    ["no answers", (r) => delete r.answers],
    ["probabilities array", (r) => (r.answers.next_char.probabilities = [])],
    ["usage missing", (r) => delete r.usage],
    ["cost not a string", (r) => (r.provider_metadata.gateway.cost = 0)],
  ];
  it.each(mutations)("throws JevResponseError on %s", (_name, mutate) => {
    const r = clone(response13);
    mutate(r);
    expect(() => mapResponse(r)).toThrow(JevResponseError);
  });

  it.each([null, "x", 1, []])("throws on non-object %j", (v) => {
    expect(() => mapResponse(v)).toThrow(JevResponseError);
  });
});
