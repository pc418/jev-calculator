import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects: pure logic in Node, the Worker handler inside workerd (Miniflare) via the pool plugin.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/protocol.test.ts", "test/score.test.ts", "test/expression.test.ts", "test/jev.test.ts", "test/runner.test.ts", "test/pass.test.ts", "test/prompts.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // The pool bundles its own workerd (miniflare 5.20260815), whose newest supported date is
            // 2026-08-22; wrangler.jsonc's 2026-09-22 makes it refuse to start. Test runtime only.
            miniflare: { compatibilityDate: "2026-08-22" },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker.test.ts"],
        },
      },
    ],
  },
});
