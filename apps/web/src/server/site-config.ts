/**
 * Per-environment settings the pages need (`wrangler.jsonc` vars, all public), read once by the
 * root route.
 */
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";

export interface SiteConfig {
  /** Cloudflare Web Analytics site token, or `null` for no analytics (unset, or local dev). */
  beaconToken: string | null;
}

/** `beaconToken` from the env vars: only outside development, and only when set. */
export function siteConfig(vars: { ENVIRONMENT?: string; CF_BEACON_TOKEN?: string }): SiteConfig {
  const token = vars.CF_BEACON_TOKEN?.trim();
  return { beaconToken: token && vars.ENVIRONMENT !== "development" ? token : null };
}

export const getSiteConfig = createServerFn({ method: "GET" }).handler(
  (): SiteConfig => siteConfig(env),
);
