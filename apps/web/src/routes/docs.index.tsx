import { loadDoc } from "virtual:zerosnake-docs";
import { createFileRoute } from "@tanstack/react-router";
import { DocArticle } from "../components/docs/DocArticle";
import { canonical, pageMeta } from "../lib/meta";

export const Route = createFileRoute("/docs/")({
  loader: async () => {
    const doc = await loadDoc("");
    if (!doc) throw new Error("docs/README.md is missing");
    return doc;
  },
  head: () => ({
    meta: [
      ...pageMeta(
        "Docs",
        "Rules, bot API, sandbox limits, rating and FAQ for ZeroSnake Arena's snake bots.",
      ),
      ...canonical("/docs").meta,
    ],
    links: canonical("/docs").links,
  }),
  component: DocsIndex,
});

function DocsIndex() {
  return <DocArticle html={Route.useLoaderData().html} />;
}
