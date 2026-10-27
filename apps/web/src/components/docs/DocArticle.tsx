import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/**
 * A rendered `docs/` page. The HTML comes from `renderDoc` at build time, which escapes any raw
 * HTML in the Markdown, so it is injected as is. Links to other doc pages navigate in the app.
 */
export function DocArticle({ html }: { html: string }) {
  const article = useRef<HTMLElement>(null);
  const router = useRouter();

  useEffect(() => {
    const el = article.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const link = (e.target as Element).closest("a");
      const href = link?.getAttribute("href");
      if (!href?.startsWith("/docs")) return;
      e.preventDefault();
      void router.navigate({ href });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [router]);

  return (
    <article
      ref={article}
      className="doc"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderDoc escapes raw HTML (html: false)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
