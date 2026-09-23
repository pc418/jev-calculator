// worker/pass.ts in Node: the pass mint/verify round trip, tamper and expiry, and verificationMode.
// siteverify() is covered end to end in test/worker.test.ts (fake challenges.cloudflare.com).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PASS_TTL_S } from "../shared/protocol";
import { allowedHostnames, mintPass, verificationMode, verifyPass } from "../worker/pass";

const env = { PASS_SECRET: "unit-pass-secret-3b9e" };
const NOW = 1_790_000_000;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** Flips one char of `s` at `i` to a different base64url char. */
const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);

describe("mintPass / verifyPass", () => {
  it("round trip: a fresh pass verifies now and until exp; payload is exp = now + PASS_TTL_S", async () => {
    const pass = await mintPass(env, NOW);
    const [payload, sig] = pass.split(".");
    expect(Buffer.from(payload!, "base64url").toString()).toBe(String(NOW + PASS_TTL_S));
    expect(Buffer.from(sig!, "base64url")).toHaveLength(32); // HMAC-SHA256
    expect(await verifyPass(env, pass, NOW)).toBe(true);
    expect(await verifyPass(env, pass, NOW + PASS_TTL_S - 1)).toBe(true);
  });

  it("expired: exp <= now → false", async () => {
    const pass = await mintPass(env, NOW);
    expect(await verifyPass(env, pass, NOW + PASS_TTL_S)).toBe(false);
    expect(await verifyPass(env, pass, NOW + PASS_TTL_S + 1)).toBe(false);
  });

  it("tampered signature, tampered payload, or another secret → false", async () => {
    const pass = await mintPass(env, NOW);
    const [payload, sig] = pass.split(".") as [string, string];
    expect(await verifyPass(env, `${payload}.${flip(sig, 5)}`, NOW)).toBe(false);
    // A later expiry with the old signature: the signature binds exp.
    expect(await verifyPass(env, `${b64url(String(NOW + 10 * PASS_TTL_S))}.${sig}`, NOW)).toBe(false);
    expect(await verifyPass({ PASS_SECRET: "other-secret" }, pass, NOW)).toBe(false);
  });

  it("matches an independent HMAC-SHA256 (node:crypto); a correctly signed non-numeric payload → false", async () => {
    const sign = (payload: string) => createHmac("sha256", env.PASS_SECRET).update(payload).digest("base64url");
    const exp = String(NOW + 60);
    expect(await verifyPass(env, `${b64url(exp)}.${sign(exp)}`, NOW)).toBe(true);
    expect(await mintPass(env, NOW)).toBe(`${b64url(String(NOW + PASS_TTL_S))}.${sign(String(NOW + PASS_TTL_S))}`);
    // Valid signature, wrong payload shape: only digits are an expiry.
    for (const bad of ["9999999999x", "", "-1", "1e12", " 9999999999"]) {
      expect(await verifyPass(env, `${b64url(bad)}.${sign(bad)}`, NOW), bad).toBe(false);
    }
  });

  it.each([
    ["empty", ""],
    ["no dot", "abc"],
    ["three parts", "a.b.c"],
    ["empty payload", ".abcd"],
    ["empty signature", "abcd."],
    ["padding", "MTc5MDAwMTgwMA==.abcd"],
    ["standard base64 chars", "a+b/.abcd"],
    ["impossible length", "a.abcde"],
    ["whitespace", " MTc5MDAwMTgwMA.abcd"],
  ])("malformed (%s) → false", async (_n, pass) => {
    expect(await verifyPass(env, pass, NOW)).toBe(false);
  });

  it("no PASS_SECRET: verifyPass false, mintPass throws", async () => {
    const pass = await mintPass(env, NOW);
    expect(await verifyPass({ PASS_SECRET: "" }, pass, NOW)).toBe(false);
    expect(await verifyPass({}, pass, NOW)).toBe(false);
    await expect(mintPass({ PASS_SECRET: "" }, NOW)).rejects.toThrow("PASS_SECRET");
  });

  it("base64url output: no '=', '+' or '/' across many passes", async () => {
    for (let i = 0; i < 64; i++) {
      const pass = await mintPass({ PASS_SECRET: `s${i}` }, NOW + i);
      expect(pass).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  });
});

describe("verificationMode", () => {
  const base = { TURNSTILE_SITEKEY: "0x4AAA", TURNSTILE_HOSTNAMES: "a.example", TURNSTILE_SECRET: "t", PASS_SECRET: "p" };
  it.each([
    ["all set", {}, "enabled"],
    ["no sitekey", { TURNSTILE_SITEKEY: "" }, "disabled"],
    ["nothing set", { TURNSTILE_SITEKEY: "", TURNSTILE_SECRET: undefined, PASS_SECRET: undefined }, "disabled"],
    ["sitekey, no PASS_SECRET", { PASS_SECRET: undefined }, "misconfigured"],
    ["sitekey, empty TURNSTILE_SECRET", { TURNSTILE_SECRET: "" }, "misconfigured"],
  ] as const)("%s → %s", (_n, over, mode) => {
    expect(verificationMode({ ...base, ...over })).toBe(mode);
  });
});

describe("allowedHostnames", () => {
  it("splits on commas, trims, lowercases, drops empties", () => {
    expect(allowedHostnames(" A.example , b.example,,")).toEqual(["a.example", "b.example"]);
    expect(allowedHostnames("")).toEqual([]);
  });
});
