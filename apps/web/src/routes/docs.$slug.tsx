import { loadDoc } from "virtual:zerosnake-docs";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocArticle } from "../components/docs/DocArticle";

export const Route = createFileRoute("/docs/$slug")({
  loader: async ({ params }) => {
    // The index is `/docs`, not `/docs/` + an empty slug.
    const doc = params.slug ? await loadDoc(params.slug) : undefined;
    if (!doc) throw notFound();
    return doc;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.title ?? "Docs"} · Docs · ZeroSnake Arena` }],
  }),
  component: DocPage,
});

function DocPage() {
  return <DocArticle html={Route.useLoaderData().html} />;
}
