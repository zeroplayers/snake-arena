import { defineConfig } from "drizzle-kit";

// Only used to generate SQL migrations (`pnpm db:generate`); wrangler applies them.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
