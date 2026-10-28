import { SITE_URL } from "../site";

const SITE_NAME = "ZeroSnake Arena";

/** The site's one-line pitch: the default description and link-preview text. */
export const DESCRIPTION =
  "A slither.io-style arena where every snake is a program. Write a JS/TS bot with Claude or by hand, deploy it with one command, and it plays everyone else's bots.";

type Meta = Record<string, string>;

/**
 * The site-wide `<head>` meta: description, Open Graph and Twitter cards with the 1200×630
 * `public/og.jpg` (its source is `og/og.html`). Pages override title and description with
 * {@link pageMeta}; TanStack keeps the deepest route's tag for each name or property.
 */
export function siteMeta(): Meta[] {
  return [
    { title: `${SITE_NAME}: your snake bot vs. everyone else's` },
    { name: "description", content: DESCRIPTION },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:type", content: "website" },
    { property: "og:title", content: `${SITE_NAME}: your snake bot vs. everyone else's` },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:image", content: `${SITE_URL}/og.jpg` },
    { property: "og:image:type", content: "image/jpeg" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: OG_ALT },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:image", content: `${SITE_URL}/og.jpg` },
    { name: "twitter:image:alt", content: OG_ALT },
  ];
}

const OG_ALT =
  "Snake bots in a glowing square arena, next to the words: Your snake bot vs. everyone else's.";

/**
 * A public page's canonical URL, as `og:url` meta and a `canonical` link, so shares with
 * `?ref=…` count as one page. Only leaf routes use it: TanStack doesn't dedupe links.
 */
export function canonical(path: string): { meta: Meta[]; links: { rel: string; href: string }[] } {
  const href = new URL(path, SITE_URL).href;
  return { meta: [{ property: "og:url", content: href }], links: [{ rel: "canonical", href }] };
}

/** A page's title (`<title>` and link previews) and, optionally, its own description. */
export function pageMeta(title: string, description?: string): Meta[] {
  const full = `${title} · ${SITE_NAME}`;
  return [
    { title: full },
    { property: "og:title", content: full },
    ...(description
      ? [
          { name: "description", content: description },
          { property: "og:description", content: description },
        ]
      : []),
  ];
}
