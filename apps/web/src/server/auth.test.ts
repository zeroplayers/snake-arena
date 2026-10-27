import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1, type TestD1 } from "../test/d1";
import { CookieJar, type FakeGithubUser, mockGithub } from "../test/github";
import { type Auth, CLI_CLIENT_ID, createAuth, isValidUsername } from "./auth";
import { type CliIdentity, type CliToken, hashToken } from "./cli-auth";

const BASE = "http://localhost:3000";

const ada: FakeGithubUser = { id: 1, login: "Ada", name: "Ada L.", email: "ada@example.com" };
const bob: FakeGithubUser = { id: 2, login: "bob", name: null, email: "bob@example.com" };

let d1: TestD1;
let auth: Auth;

beforeEach(async () => {
  d1 = await createTestD1();
  auth = createAuth({
    DB: d1.db,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await d1.dispose();
});

interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  jar?: CookieJar;
  bearer?: string;
  /** `Origin` header; the site's own by default, `null` to omit it (like the CLI). */
  origin?: string | null;
}

async function call(
  path: string,
  { method = "GET", body, jar, bearer, origin = BASE }: CallOptions = {},
) {
  const headers = new Headers({ "user-agent": "vitest" });
  if (origin) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (jar) headers.set("cookie", jar.header());
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const res = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  jar?.store(res);
  return res;
}

const post = (path: string, body: unknown, options: CallOptions = {}) =>
  call(path, { ...options, method: "POST", body });

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Runs the whole GitHub redirect dance and returns a jar holding the session cookie. */
async function signInWithGithub(user: FakeGithubUser) {
  mockGithub(user);
  const jar = new CookieJar();
  const start = await post(
    "/sign-in/social",
    { provider: "github", callbackURL: "/welcome" },
    {
      jar,
    },
  );
  expect(start.status).toBe(200);
  const { url } = await json<{ url: string }>(start);
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);

  const state = authorize.searchParams.get("state") ?? "";
  const callback = await call(`/callback/github?code=fake-code&state=${state}`, { jar });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/welcome");
  return jar;
}

const claim = (jar: CookieJar, username: string) => post("/username/claim", { username }, { jar });

/** Signs in and claims the GitHub login as username, like most people will. */
async function signUp(user: FakeGithubUser) {
  const jar = await signInWithGithub(user);
  expect((await claim(jar, user.login)).status).toBe(200);
  return jar;
}

type SessionResponse = {
  user: { id: string; username?: string | null; githubLogin?: string | null; email: string };
  session: { id: string };
} | null;

const getSession = async (options: CallOptions) =>
  json<SessionResponse>(await call("/get-session", options));

// ─── Device flow helpers ─────────────────────────────────────────────────────────────────────────

type DeviceCode = { device_code: string; user_code: string; verification_uri: string };
type TokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
};

async function startDeviceFlow() {
  const res = await post("/device/code", { client_id: CLI_CLIENT_ID }, { origin: null });
  expect(res.status).toBe(200);
  return json<DeviceCode>(res);
}

const pollToken = async (deviceCode: string, path = "/cli/token") =>
  json<TokenResponse>(
    await post(
      path,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLI_CLIENT_ID,
      },
      { origin: null },
    ),
  );

/** Skips the polling interval instead of waiting 5 s. */
const rewindPoll = (deviceCode: string) =>
  d1.db
    .prepare("UPDATE device_codes SET last_polled_at = 0 WHERE device_code = ?")
    .bind(deviceCode)
    .run();

/** What the /device page does: look the code up (ties it to the user), then approve. */
async function approve(jar: CookieJar, userCode: string) {
  const verify = await call(`/device?user_code=${userCode}`, { jar });
  expect(await json(verify)).toMatchObject({ status: "pending" });
  return post("/device/approve", { userCode }, { jar });
}

/** Full `zerosnake login`; returns the CLI's bearer token. */
async function loginCli(jar: CookieJar) {
  const code = await startDeviceFlow();
  expect(await pollToken(code.device_code)).toMatchObject({ error: "authorization_pending" });
  expect((await approve(jar, code.user_code)).status).toBe(200);
  await rewindPoll(code.device_code);
  const token = await pollToken(code.device_code);
  expect(token).toMatchObject({ token_type: "Bearer" });
  return token.access_token ?? "";
}

const whoami = (token: string) => call("/cli/me", { bearer: token, origin: null });

// ─── Tests ───────────────────────────────────────────────────────────────────────────────────────

describe("GitHub sign-in", () => {
  it("creates the user and a web session; username is chosen later", async () => {
    const jar = await signInWithGithub(ada);
    const session = await getSession({ jar });
    expect(session?.user).toMatchObject({
      email: "ada@example.com",
      githubLogin: "Ada",
      username: null,
    });

    const account = await d1.db
      .prepare("SELECT provider_id, account_id, access_token FROM accounts WHERE user_id = ?")
      .bind(session?.user.id)
      .first<{ provider_id: string; account_id: string; access_token: string }>();
    expect(account).toMatchObject({ provider_id: "github", account_id: "1" });
    // Encrypted at rest.
    expect(account?.access_token).not.toContain("gho_");
  });

  it("signs the same GitHub account back into the same user", async () => {
    const first = await getSession({ jar: await signInWithGithub(ada) });
    const second = await getSession({ jar: await signInWithGithub(ada) });
    expect(second?.user.id).toBe(first?.user.id);
  });
});

describe("origin checks (on in tests too)", () => {
  it("rejects cookie-authenticated POSTs from another origin", async () => {
    const jar = await signInWithGithub(ada);
    const res = await post(
      "/username/claim",
      { username: "ada" },
      {
        jar,
        origin: "https://evil.example",
      },
    );
    expect(res.status).toBe(403);
    expect((await getSession({ jar }))?.user.username).toBeNull();
  });

  it("rejects a callbackURL on another origin", async () => {
    const res = await post("/sign-in/social", {
      provider: "github",
      callbackURL: "https://evil.example/steal",
    });
    expect(res.status).toBe(403);
  });
});

describe("username", () => {
  it("is claimed once, normalised to lowercase", async () => {
    const jar = await signInWithGithub(ada);
    const res = await claim(jar, "Ada_Lovelace");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ username: "ada_lovelace" });
    expect((await getSession({ jar }))?.user.username).toBe("ada_lovelace");
  });

  it("can't be changed once chosen", async () => {
    const jar = await signUp(ada);
    const res = await claim(jar, "ada2");
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "USERNAME_ALREADY_SET" });
    expect((await getSession({ jar }))?.user.username).toBe("ada");
  });

  it("lets only one of two racing claims win", async () => {
    const jar = await signInWithGithub(ada);
    const results = await Promise.all([claim(jar, "first"), claim(jar, "second")]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    const winner = results.findIndex((r) => r.status === 200) === 0 ? "first" : "second";
    expect((await getSession({ jar }))?.user.username).toBe(winner);
  });

  it("is unique", async () => {
    await signUp({ ...ada, login: "snek" });
    const bobJar = await signInWithGithub(bob);
    const taken = await claim(bobJar, "Snek");
    expect(taken.status).toBe(400);
    expect(await json(taken)).toMatchObject({ code: "USERNAME_IS_ALREADY_TAKEN" });
    expect((await getSession({ jar: bobJar }))?.user.username).toBeNull();
  });

  it.each(["a", "-bob", "bob-", "bo b", "bob.js", "settings", "House", "x".repeat(40)])(
    "rejects %j",
    async (name) => {
      const jar = await signInWithGithub(bob);
      const res = await claim(jar, name);
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: "INVALID_USERNAME" });
    },
  );

  it("accepts GitHub-style names", () => {
    for (const name of ["ab", "bob", "ada-lovelace", "snake_42", "x".repeat(39)]) {
      expect(isValidUsername(name)).toBe(true);
    }
  });
});

describe("profile fields", () => {
  it("can't be edited: /update-user is disabled", async () => {
    const jar = await signUp(ada);
    for (const body of [
      { image: "https://evil.example/pixel.gif" },
      { name: "Someone else" },
      { username: "other" },
      { githubLogin: "torvalds" },
    ]) {
      expect((await post("/update-user", body, { jar })).status).toBe(404);
    }
    expect((await getSession({ jar }))?.user).toMatchObject({
      username: "ada",
      githubLogin: "Ada",
    });
  });

  it("raw session tokens are not listable", async () => {
    const jar = await signUp(ada);
    expect((await call("/list-sessions", { jar })).status).toBe(404);
  });
});

describe("device flow (zerosnake login)", () => {
  it("issues a verification URL on the site", async () => {
    const code = await startDeviceFlow();
    expect(code.verification_uri).toBe(`${BASE}/device`);
    expect(code.user_code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it("only serves the zerosnake CLI client", async () => {
    const res = await post("/device/code", { client_id: "other" }, { origin: null });
    expect(res.status).toBe(400);
  });

  it("needs a username before the CLI can be approved", async () => {
    const jar = await signInWithGithub(ada);
    const code = await startDeviceFlow();
    expect((await approve(jar, code.user_code)).status).toBe(403);
  });

  it("can't be approved by a banned user, and a banned user's token can't act", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    await d1.db
      .prepare("UPDATE users SET banned_at = 1, ban_reason = 'spam' WHERE username = 'ada'")
      .run();
    const code = await startDeviceFlow();
    const refused = await approve(jar, code.user_code);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ message: "Your account is suspended" });
    // Still identifies (so the CLI can say why), but carries the ban.
    expect(await json(await whoami(token))).toMatchObject({
      user: { username: "ada" },
      banned: { reason: "spam" },
    });
  });

  it("gives the CLI an opaque token, stored only as a hash", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    expect(token).toMatch(/^zsk_[A-Za-z0-9_-]{43}$/);

    const me = await json<CliIdentity>(await whoami(token));
    expect(me.user).toMatchObject({ username: "ada" });

    const rows = await d1.db.prepare("SELECT * FROM cli_tokens").all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.token_hash).toBe(await hashToken(token));
    expect(JSON.stringify(rows.results)).not.toContain(token);
    // No Better Auth session was created for the CLI.
    const sessions = await d1.db.prepare("SELECT count(*) AS n FROM sessions").first("n");
    expect(sessions).toBe(1);
  });

  it("redeems a device code only once", async () => {
    const jar = await signUp(ada);
    const code = await startDeviceFlow();
    await approve(jar, code.user_code);
    expect(await pollToken(code.device_code)).toMatchObject({ token_type: "Bearer" });
    await rewindPoll(code.device_code);
    expect(await pollToken(code.device_code)).toMatchObject({ error: "invalid_grant" });
  });

  it("returns access_denied when the user denies", async () => {
    const jar = await signUp(ada);
    const code = await startDeviceFlow();
    await call(`/device?user_code=${code.user_code}`, { jar });
    await post("/device/deny", { userCode: code.user_code }, { jar });
    expect(await pollToken(code.device_code)).toMatchObject({ error: "access_denied" });
  });

  it("doesn't offer Better Auth's session-minting token endpoint", async () => {
    const jar = await signUp(ada);
    const code = await startDeviceFlow();
    await approve(jar, code.user_code);
    const res = await post(
      "/device/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: CLI_CLIENT_ID,
      },
      { origin: null },
    );
    expect(res.status).toBe(404);
  });
});

describe("CLI token scope", () => {
  it("is not a Better Auth session", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    const asCli = { bearer: token, origin: null } as const;

    expect(await getSession(asCli)).toBeNull();
    expect((await call("/cli/tokens", asCli)).status).toBe(401);
    expect((await post("/revoke-sessions", {}, asCli)).status).toBe(401);
    expect((await post("/username/claim", { username: "x2" }, asCli)).status).toBe(401);

    // Can't approve more devices for the account.
    const other = await startDeviceFlow();
    await call(`/device?user_code=${other.user_code}`, asCli);
    expect((await post("/device/approve", { userCode: other.user_code }, asCli)).status).toBe(401);

    // The web session is untouched.
    expect((await getSession({ jar }))?.user.username).toBe("ada");
  });

  it("rejects unknown and expired tokens", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    expect((await whoami(`${token}x`)).status).toBe(401);
    expect((await whoami("not-a-token")).status).toBe(401);

    await d1.db.prepare("UPDATE cli_tokens SET expires_at = 0").run();
    expect((await whoami(token)).status).toBe(401);
  });
});

describe("CLI tokens in settings", () => {
  const list = async (jar: CookieJar) => {
    const res = await call("/cli/tokens", { jar });
    expect(res.status).toBe(200);
    return json<CliToken[]>(res);
  };

  it("lists the user's tokens without any secret", async () => {
    const jar = await signUp(ada);
    await loginCli(jar);
    await loginCli(jar);

    const tokens = await list(jar);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ userAgent: "vitest" });
    expect(Object.keys(tokens[0] ?? {}).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "ipAddress",
      "lastUsedAt",
      "userAgent",
    ]);
  });

  it("revokes a token so the CLI is signed out", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    const [listed] = await list(jar);

    const res = await post("/cli/tokens/revoke", { id: listed?.id }, { jar });
    expect(res.status).toBe(200);
    expect((await whoami(token)).status).toBe(401);
    expect(await list(jar)).toEqual([]);
  });

  it("lets the CLI sign itself out", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    const res = await post("/cli/logout", {}, { bearer: token, origin: null });
    expect(res.status).toBe(200);
    expect((await whoami(token)).status).toBe(401);
  });

  it("can't revoke other users' tokens", async () => {
    const adaJar = await signUp(ada);
    const adaToken = await loginCli(adaJar);
    const [adaCli] = await list(adaJar);

    const bobJar = await signUp(bob);
    const res = await post("/cli/tokens/revoke", { id: adaCli?.id }, { jar: bobJar });
    expect(res.status).toBe(404);
    expect((await whoami(adaToken)).status).toBe(200);
  });

  it("requires a web session", async () => {
    expect((await call("/cli/tokens")).status).toBe(401);
  });
});
