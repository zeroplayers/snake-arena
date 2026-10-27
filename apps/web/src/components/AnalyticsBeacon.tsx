/**
 * Cloudflare Web Analytics (cookieless: no cookies, no local storage, no fingerprinting), loaded
 * when the environment has a `CF_BEACON_TOKEN` (`getSiteConfig`). It follows client-side
 * navigation by itself. Rendered by the server only: React doesn't run scripts it inserts
 * later, so a first page without it (dev, tests, `/device`) loads none. The CLI's one-time code
 * (`/device?user_code=…`, also inside `/welcome?next=`) only arrives with a full page load,
 * which then has no beacon, and `/welcome` goes on to `/device` with a full load too.
 *
 * If the site ever sends a Content-Security-Policy, it must allow
 * `script-src https://static.cloudflareinsights.com` and
 * `connect-src https://cloudflareinsights.com`.
 */
export function AnalyticsBeacon({ token }: { token: string | null }) {
  if (!token) return null;
  return (
    <script
      defer
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={JSON.stringify({ token })}
    />
  );
}
