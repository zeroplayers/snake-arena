import { createFileRoute } from "@tanstack/react-router";
import { getProfile } from "../../../db/queries";
import { getDb } from "../../../server/env";

export const Route = createFileRoute("/api/users/$username")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const profile = await getProfile(getDb(), params.username);
        return profile
          ? Response.json(profile)
          : Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
