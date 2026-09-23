// GENERATED from prompts/jev-prompts.md by scripts/sync-prompts.mjs — edit the .md, then `npm run prompts`.
// Every LLM-facing string the Worker sends lives here. No conditional pieces: the body is identical every step.
import type { Option } from "../shared/protocol";

export type Criteria = Record<Option, string | null>;

export interface PromptSpec {
  /** state templates: {expression} = wire expression, {prefix} = answer so far */
  state: Record<string, string>;
  instructions: string;
  criteria: Criteria;
}

export const ACTIVE_PROMPT_ID = "A";

export const PROMPTS: Record<string, PromptSpec> = {
  "A": {
    "state": {
      "expression_so_far": "{expression} =",
      "digits_emitted": "{prefix}"
    },
    "instructions": "You are a calculator. The exact result of the expression is built in digits_emitted one token at a time. Append the next token of the result; choose END only when digits_emitted already holds the complete result.",
    "criteria": {
      "0": null,
      "1": null,
      "2": null,
      "3": null,
      "4": null,
      "5": null,
      "6": null,
      "7": null,
      "8": null,
      "9": null,
      ".": null,
      "-": null,
      "END": null
    }
  },
  "B": {
    "state": {
      "expression": "{expression}",
      "answer_prefix": "{prefix}"
    },
    "instructions": "Continue the attempted decimal answer to `expression` after `answer_prefix`. Choose the next character to append, or END to finish. Use ordinary decimal notation, without exponent notation.",
    "criteria": {
      "0": null,
      "1": null,
      "2": null,
      "3": null,
      "4": null,
      "5": null,
      "6": null,
      "7": null,
      "8": null,
      "9": null,
      ".": "The decimal point, after an integer digit and only once.",
      "-": "A leading minus sign for a negative answer; before any other character.",
      "END": "The answer is complete; no further character follows. An empty prefix is not a complete answer."
    }
  }
};
