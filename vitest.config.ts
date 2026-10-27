import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "bots/*", "apps/*", "template"],
    passWithNoTests: true,
  },
});
