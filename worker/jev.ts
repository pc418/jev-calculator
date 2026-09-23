// Jev request builder + response mapper. Design: docs/260922-plan-jev-calculator.md §3.2, §4, §7.
// Every LLM-facing string lives in PROMPT_A / PROMPT_B below, verbatim from doc §7. The request has no conditional
// part: every step sends the same instructions and all 13 criteria; only the state values change.
import { OPTIONS, type NextResponse, type Option } from "../shared/protocol";

import { ACTIVE_PROMPT_ID, PROMPTS, type Criteria, type PromptSpec } from "./prompts";

export type { Criteria };

/** A prompt with its state templates resolved into a function; built from the generated PROMPTS. */
export interface Prompt {
  id: string;
  instructions: string;
  criteria: Criteria;
  state: (expression: string, prefix: string) => Record<string, string>;
}

export interface JevRequest {
  model: string;
  state: Record<string, string>;
  /** Criteria for all 13 options, in OPTIONS order. */
  questions: { next_char: { type: "choice"; instructions: string; criteria: Criteria } };
}

/** NextResponse minus upstream_ms and route, which the handler adds. */
export type MappedResponse = Omit<NextResponse, "upstream_ms" | "route">;

/** Upstream answered 2xx with a body that is not the expected Jev shape. */
export class JevResponseError extends Error {
  override name = "JevResponseError";
}

function fill(template: string, expression: string, prefix: string): string {
  return template.replaceAll("{expression}", expression).replaceAll("{prefix}", prefix);
}

export function toPrompt(id: string, spec: PromptSpec): Prompt {
  return {
    id,
    instructions: spec.instructions,
    criteria: spec.criteria,
    state: (expression, prefix) =>
      Object.fromEntries(Object.entries(spec.state).map(([k, t]) => [k, fill(t, expression, prefix)])),
  };
}

/** The prompt the Worker sends: the one marked (active) in prompts/jev-prompts.md. */
export const ACTIVE_PROMPT: Prompt = toPrompt(ACTIVE_PROMPT_ID, PROMPTS[ACTIVE_PROMPT_ID]!);
/** Kept for tests and A/B scripts: the baseline and the Codex candidate by their md ids. */
export const PROMPT_A: Prompt = toPrompt("A", PROMPTS["A"]!);
export const PROMPT_B: Prompt = toPrompt("B", PROMPTS["B"]!);

export function buildRequest(model: string, expression: string, prefix: string): JevRequest {
  const prompt = ACTIVE_PROMPT;
  // Criteria re-emitted in OPTIONS order so the body is byte-stable (object spread keeps key order anyway).
  const criteria = Object.fromEntries(OPTIONS.map((o) => [o, prompt.criteria[o]])) as Criteria;
  return {
    model,
    state: prompt.state(expression, prefix),
    questions: { next_char: { type: "choice", instructions: prompt.instructions, criteria } },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const round2 = (v: number): number => Math.round(v * 100) / 100;

function optionalString(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new JevResponseError(`${field} is not a string`);
  return v;
}

/**
 * Validates the gateway/TypeSafe response and maps it to the page's shape. Probabilities are
 * re-rounded to 2 dp (float noise) but never renormalised; `choice` is the API's, never an argmax.
 * The direct API sends no provider_metadata, so cost/market_cost/generation_id are then "".
 * The response must carry exactly the 13 option keys and choose one of them.
 */
export function mapResponse(json: unknown): MappedResponse {
  if (!isObject(json) || !isObject(json.answers)) throw new JevResponseError("missing answers");
  const a = json.answers.next_char;
  if (!isObject(a) || a.type !== "choice") throw new JevResponseError("answers.next_char is not a choice");

  const probs = a.probabilities;
  if (!isObject(probs)) throw new JevResponseError("missing probabilities");
  const keys = Object.keys(probs);
  const unknown = keys.filter((k) => !(OPTIONS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new JevResponseError(`unknown options: ${unknown.join(",")}`);
  const probabilities = {} as Record<Option, number>;
  for (const o of OPTIONS) {
    const v = probs[o];
    if (!isUnit(v)) throw new JevResponseError(`probability for ${JSON.stringify(o)} missing or outside [0,1]`);
    probabilities[o] = round2(v);
  }

  if (typeof a.choice !== "string" || !(OPTIONS as readonly string[]).includes(a.choice)) {
    throw new JevResponseError("choice is not one of the 13 options");
  }
  if (!isUnit(a.confidence)) throw new JevResponseError("confidence missing or outside [0,1]");

  const usage = json.usage;
  if (!isObject(usage) || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
    throw new JevResponseError("usage missing");
  }

  const pm = isObject(json.provider_metadata) ? json.provider_metadata : {};
  const gw = isObject(pm.gateway) ? pm.gateway : {};

  return {
    choice: a.choice as Option,
    confidence: round2(a.confidence),
    probabilities,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    cost: optionalString(gw.cost, "cost"),
    market_cost: optionalString(gw.marketCost, "marketCost"),
    generation_id: optionalString(gw.generationId, "generationId"),
    model: typeof json.model === "string" ? json.model : "",
  };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
