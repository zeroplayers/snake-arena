import { defineProject } from "vitest/config";

// Keeps Vitest from loading vite.config.ts (Cloudflare + TanStack Start plugins need a dev server).
export default defineProject({
  // Tests talk to workerd (D1, R2, Queues) through wrangler's platform proxy; give them headroom.
  test: { name: "web", testTimeout: 20_000 },
});
