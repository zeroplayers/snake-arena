import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docsPlugin } from "./src/docs/plugin.ts";

export default defineConfig({
  server: { port: 3000 },
  plugins: [
    // Local D1/R2/Queue state is shared with `apps/arena` (`wrangler dev --persist-to`).
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: "../../.wrangler/state" },
    }),
    docsPlugin(fileURLToPath(new URL("../../docs", import.meta.url))),
    tanstackStart(),
    viteReact(),
  ],
});
