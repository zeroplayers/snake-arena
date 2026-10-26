import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// Keeps Vitest from loading vite.config.ts (Cloudflare + TanStack Start plugins need a dev server).
export default defineProject({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("src/test/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  // Tests talk to workerd (D1, R2, Queues) through wrangler's platform proxy; give them headroom.
  test: { name: "web", testTimeout: 20_000 },
});
