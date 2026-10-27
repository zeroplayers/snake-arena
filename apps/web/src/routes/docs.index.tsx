import { loadDoc } from "virtual:zerosnake-docs";
import { createFileRoute } from "@tanstack/react-router";
import { DocArticle } from "../components/docs/DocArticle";

export const Route = createFileRoute("/docs/")({
  loader: async () => {
    const doc = await loadDoc("");
    if (!doc) throw new Error("docs/README.md is missing");
    return doc;
  },
  head: () => ({ meta: [{ title: "Docs · ZeroSnake Arena" }] }),
  component: DocsIndex,
});

function DocsIndex() {
  return <DocArticle html={Route.useLoaderData().html} />;
}
