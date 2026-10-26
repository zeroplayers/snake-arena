#!/usr/bin/env node
import { existsSync } from "node:fs";

// In a checkout of the monorepo, bundle the TypeScript sources first (fast), so this always
// runs the current code. A published package ships dist/ and no scripts/.
if (existsSync(new URL("../scripts/build.ts", import.meta.url))) {
  const { buildCli } = await import("../scripts/build.ts");
  await buildCli();
}
const { main } = await import("../dist/cli.js");
process.exitCode = await main(process.argv.slice(2));
