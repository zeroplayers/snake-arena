/**
 * `www.` hosts (`www.zerosnake.dev`, a custom domain of the site Worker in wrangler.jsonc)
 * redirect permanently to the bare host, keeping path and query.
 */
export function wwwRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (!url.hostname.startsWith("www.")) return null;
  url.hostname = url.hostname.slice("www.".length);
  return Response.redirect(url.href, 301);
}
