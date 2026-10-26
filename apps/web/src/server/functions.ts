/**
 * Server functions for route loaders. Each runs on the Worker; on the client they become RPC calls.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getProfile } from "../db/queries";
import { getAuth, getDb } from "./env";

export interface Viewer {
  id: string;
  name: string;
  image: string | null;
  username: string | null;
  githubLogin: string | null;
}

export const getViewer = createServerFn({ method: "GET" }).handler(
  async (): Promise<Viewer | null> => {
    const session = await getAuth().api.getSession({ headers: getRequest().headers });
    if (!session) return null;
    const { id, name, image, username, githubLogin } = session.user;
    return {
      id,
      name,
      image: image ?? null,
      username: username ?? null,
      githubLogin: githubLogin ?? null,
    };
  },
);

export const getCliTokens = createServerFn({ method: "GET" }).handler(async () =>
  getAuth().api.listCliTokens({ headers: getRequest().headers }),
);

export const getProfileData = createServerFn({ method: "GET" })
  .validator((username: string) => username)
  .handler(({ data }) => getProfile(getDb(), data));
