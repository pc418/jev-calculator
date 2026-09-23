import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `wrangler dev` serves the API during local dev; Vite proxies /api to it.
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        // The Worker rejects a foreign Origin; the browser's localhost:5173 origin would be foreign to :8787.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
});
