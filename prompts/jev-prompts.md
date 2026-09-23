# Jev prompts

Edit this file, then run `npm run prompts` (also runs before `npm test` and `npm run build`).
It regenerates `worker/prompts.ts`, the only place the Worker reads prompts from.

Format rules (the generator is strict and fails loudly):
- Each prompt is a `## <ID>` section; exactly one carries `(active)`.
- `### state` lines are `key: template`; templates may use `{expression}` (wire string, e.g. `347 * 29`) and `{prefix}` (answer so far, may be empty).
- `### instructions` is free text; lines are joined with single spaces.
- `### criteria` lists all 13 options `0`–`9`, `.`, `-`, `END` as `option: description`; an empty description sends `null` (option name only).
- Question IDs are not sent to the model; the whole meaning must be in the text. Jev reads literally: state the exact condition, put boundary cases in the criteria, avoid multi-hop wording.

## A (active)

Shipped prompt. The answer so far sits in its own field: with a single `{expression} = {prefix}` line, Jev picked END before the first digit. The END clause in the instructions is what stops runaway digits (`17 mod 5` → `2222…` without it). Large products still stop after the leading two or three digits; that is the classifier, not the wording.

### state
expression_so_far: {expression} =
digits_emitted: {prefix}

### instructions
You are a calculator. The exact result of the expression is built in digits_emitted one token at a time. Append the next token of the result; choose END only when digits_emitted already holds the complete result.

### criteria
0:
1:
2:
3:
4:
5:
6:
7:
8:
9:
.:
-:
END:

## B

Codex candidate. Terminates eagerly; was wrong on `12 + 3` and `sqrt(144)` in the 2026-09-22 A/B.

### state
expression: {expression}
answer_prefix: {prefix}

### instructions
Continue the attempted decimal answer to `expression` after `answer_prefix`.
Choose the next character to append, or END to finish.
Use ordinary decimal notation, without exponent notation.

### criteria
0:
1:
2:
3:
4:
5:
6:
7:
8:
9:
.: The decimal point, after an integer digit and only once.
-: A leading minus sign for a negative answer; before any other character.
END: The answer is complete; no further character follows. An empty prefix is not a complete answer.

