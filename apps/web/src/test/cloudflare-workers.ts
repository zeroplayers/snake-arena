/**
 * Stand-in for the `cloudflare:workers` module under Vitest (aliased in vitest.config.ts), so
 * route handlers that read `env` can run outside workerd. Tests fill `env` with test bindings.
 */
export const env: Record<string, unknown> = {};
