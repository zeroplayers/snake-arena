/**
 * A fake GitHub for the OAuth flow: stubs the token exchange and the user API on global `fetch`.
 */
import { vi } from "vitest";

export interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string;
  avatar_url?: string;
}

export function mockGithub(user: FakeGithubUser) {
  const realFetch = globalThis.fetch;
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: `gho_${user.login}`,
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url.href === "https://api.github.com/user") {
      return Response.json({
        id: user.id,
        login: user.login,
        name: user.name,
        email: null,
        avatar_url: user.avatar_url ?? `https://avatars.githubusercontent.com/u/${user.id}`,
      });
    }
    if (url.href === "https://api.github.com/user/emails") {
      return Response.json([{ email: user.email, primary: true, verified: true }]);
    }
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", fake);
  return fake;
}

/** Minimal cookie jar: keeps `name=value` pairs from `Set-Cookie`, honours deletion. */
export class CookieJar {
  private cookies = new Map<string, string>();

  store(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = header.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
