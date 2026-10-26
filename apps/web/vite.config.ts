import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000 },
  plugins: [
    // Local D1/R2/Queue state is shared with `apps/arena` (`wrangler dev --persist-to`).
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: "../../.wrangler/state" },
    }),
    tanstackStart(),
    viteReact(),
  ],
});
