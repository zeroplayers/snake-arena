import { defineProject } from "vitest/config";

// Keeps Vitest from loading vite.config.ts (Cloudflare + TanStack Start plugins need a dev server).
export default defineProject({
  test: { name: "web" },
});
