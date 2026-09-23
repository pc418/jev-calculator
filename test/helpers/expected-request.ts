// The upstream body the Worker must send, derived from the (active) prompt in prompts/jev-prompts.md.
// Tests compare against this instead of a frozen text fixture, so owner edits to the md don't break them;
// the md ↔ generated ↔ buildRequest chain itself is pinned in test/prompts.test.ts.
// Criteria cover all 13 options, in OPTIONS order (nothing is ever masked).
import { OPTIONS } from "../../shared/protocol";
import { ACTIVE_PROMPT, type JevRequest } from "../../worker/jev";

export function expectedRequest(model: string, expression: string, prefix: string): JevRequest {
  return {
    model,
    state: ACTIVE_PROMPT.state(expression, prefix),
    questions: {
      next_char: {
        type: "choice",
        instructions: ACTIVE_PROMPT.instructions,
        criteria: Object.fromEntries(OPTIONS.map((o) => [o, ACTIVE_PROMPT.criteria[o]])) as JevRequest["questions"]["next_char"]["criteria"],
      },
    },
  };
}
