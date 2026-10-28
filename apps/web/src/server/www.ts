/**
 * `www.` hosts (`www.zerosnake.dev`, a custom domain of the site Worker in wrangler.jsonc)
 * redirect permanently to the bare host, keeping path and query.
 *
 * Only requests that reach the Worker: static assets (`/robots.txt`, `/sitemap.xml`, `/og.jpg`,
 * `/assets/*`) are served before it, on www too. The zone's Redirect Rule (README, "www") covers
 * everything; this stays as the fallback.
 */
export function wwwRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (!url.hostname.startsWith("www.")) return null;
  url.hostname = url.hostname.slice("www.".length);
  return Response.redirect(url.href, 301);
}
