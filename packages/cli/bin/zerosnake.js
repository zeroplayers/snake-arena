#!/usr/bin/env node
import { existsSync } from "node:fs";

// dist/ is built before packing (`prepack`); in a checkout, build it with
// `pnpm --filter zerosnake build`. This file never builds anything itself.
const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  console.error("zerosnake isn't built: run `pnpm --filter zerosnake build` in the monorepo.");
  process.exit(1);
}
const { main } = await import(cli.href);
process.exitCode = await main(process.argv.slice(2));
