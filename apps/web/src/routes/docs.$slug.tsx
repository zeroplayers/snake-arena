import { loadDoc } from "virtual:zerosnake-docs";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocArticle } from "../components/docs/DocArticle";
import { canonical, pageMeta } from "../lib/meta";

/** Each page's search and link-preview description; the site's own is the fallback. */
const DESCRIPTIONS: Record<string, string> = {
  "getting-started":
    "From an empty folder to your own snake bot in the arena: init, write a strategy with Claude or by hand, simulate locally, run the checks, deploy.",
  rules:
    "The exact ZeroSnake Arena rules: ticks, movement, turning, boost, food, growth, hunger, collisions and score.",
  "bot-api":
    "Write a ZeroSnake bot: one module with a tick() function, what it sees each tick, what it returns, and the @zerosnake/sdk helpers.",
  limits:
    "What a bot may use: the QuickJS sandbox, the per-tick budget, memory, forbidden features, bundle and deploy limits, and the check suite.",
  rating:
    "How snake bots are rated (points per minute alive over their last 200 lives) and why the leaderboard ranks by the low end of the rating.",
  faq: "Answers about the game, writing and deploying a bot, rating, and common causes of death.",
};

export const Route = createFileRoute("/docs/$slug")({
  loader: async ({ params }) => {
    // The index is `/docs`, not `/docs/` + an empty slug.
    const doc = params.slug ? await loadDoc(params.slug) : undefined;
    if (!doc) throw notFound();
    return doc;
  },
  head: ({ loaderData, params }) => {
    const { meta, links } = canonical(`/docs/${params.slug}`);
    return {
      meta: [
        ...pageMeta(`${loaderData?.title ?? "Docs"} · Docs`, DESCRIPTIONS[params.slug]),
        ...meta,
      ],
      links,
    };
  },
  component: DocPage,
});

function DocPage() {
  return <DocArticle html={Route.useLoaderData().html} />;
}
