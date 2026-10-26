import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1, type TestD1 } from "../test/d1";
import { CookieJar, type FakeGithubUser, mockGithub } from "../test/github";
import { type Auth, CLI_CLIENT_ID, createAuth, isValidUsername } from "./auth";
import type { CliToken } from "./cli-tokens";

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
}

async function call(path: string, { method = "GET", body, jar, bearer }: CallOptions = {}) {
  const headers = new Headers({ origin: BASE, "user-agent": "vitest" });
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

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Runs the whole GitHub redirect dance and returns a jar holding the session cookie. */
async function signInWithGithub(user: FakeGithubUser) {
  mockGithub(user);
  const jar = new CookieJar();
  const start = await call("/sign-in/social", {
    method: "POST",
    body: { provider: "github", callbackURL: "/welcome" },
    jar,
  });
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

/** Signs in and picks the GitHub login as username, like most people will. */
async function signUp(user: FakeGithubUser) {
  const jar = await signInWithGithub(user);
  const res = await call("/update-user", {
    method: "POST",
    body: { username: user.login },
    jar,
  });
  expect(res.status).toBe(200);
  return jar;
}

type SessionResponse = {
  user: { id: string; username?: string | null; githubLogin?: string | null; email: string };
  session: { id: string; kind: string };
} | null;

const getSession = async (auth: CallOptions) =>
  json<SessionResponse>(await call("/get-session", auth));

describe("GitHub sign-in", () => {
  it("creates the user and a web session; username is chosen later", async () => {
    const jar = await signInWithGithub(ada);
    const session = await getSession({ jar });
    expect(session?.user).toMatchObject({
      email: "ada@example.com",
      githubLogin: "Ada",
      username: null,
    });
    expect(session?.session.kind).toBe("web");

    const account = await d1.db
      .prepare("SELECT provider_id, account_id FROM accounts WHERE user_id = ?")
      .bind(session?.user.id)
      .first();
    expect(account).toEqual({ provider_id: "github", account_id: "1" });
  });

  it("signs the same GitHub account back into the same user", async () => {
    const first = await getSession({ jar: await signInWithGithub(ada) });
    const second = await getSession({ jar: await signInWithGithub(ada) });
    expect(second?.user.id).toBe(first?.user.id);
  });
});

describe("username", () => {
  it("is set once on first sign-in, normalised to lowercase", async () => {
    const jar = await signInWithGithub(ada);
    const res = await call("/update-user", {
      method: "POST",
      body: { username: "Ada_Lovelace" },
      jar,
    });
    expect(res.status).toBe(200);
    expect((await getSession({ jar }))?.user.username).toBe("ada_lovelace");
  });

  it("can't be changed once chosen", async () => {
    const jar = await signUp(ada);
    const res = await call("/update-user", { method: "POST", body: { username: "ada2" }, jar });
    expect(res.status).toBe(400);
    expect((await getSession({ jar }))?.user.username).toBe("ada");
  });

  it("keeps githubLogin read-only", async () => {
    const jar = await signInWithGithub(ada);
    const res = await call("/update-user", {
      method: "POST",
      body: { githubLogin: "torvalds" },
      jar,
    });
    expect(res.status).toBe(400);
    expect((await getSession({ jar }))?.user.githubLogin).toBe("Ada");
  });

  it("is unique", async () => {
    const adaJar = await signInWithGithub(ada);
    await call("/update-user", { method: "POST", body: { username: "snek" }, jar: adaJar });

    const bobJar = await signInWithGithub(bob);
    const available = await call("/is-username-available", {
      method: "POST",
      body: { username: "SNEK" },
      jar: bobJar,
    });
    expect(await json(available)).toEqual({ available: false });

    const taken = await call("/update-user", {
      method: "POST",
      body: { username: "Snek" },
      jar: bobJar,
    });
    expect(taken.status).toBe(400);
    expect((await getSession({ jar: bobJar }))?.user.username).toBeNull();
  });

  it.each(["a", "-bob", "bob-", "bo b", "bob.js", "settings", "House", "x".repeat(40)])(
    "rejects %j",
    async (name) => {
      const jar = await signInWithGithub(bob);
      const res = await call("/update-user", { method: "POST", body: { username: name }, jar });
      expect(res.status).toBe(400);
    },
  );

  it("accepts GitHub-style names", () => {
    for (const name of ["ab", "bob", "ada-lovelace", "snake_42", "x".repeat(39)]) {
      expect(isValidUsername(name)).toBe(true);
    }
  });
});

describe("device flow (zerosnake login)", () => {
  type DeviceCode = { device_code: string; user_code: string; verification_uri: string };
  type TokenResponse = { access_token?: string; token_type?: string; error?: string };

  async function startDeviceFlow() {
    const res = await call("/device/code", { method: "POST", body: { client_id: CLI_CLIENT_ID } });
    expect(res.status).toBe(200);
    return json<DeviceCode>(res);
  }

  const pollToken = async (deviceCode: string) =>
    json<TokenResponse>(
      await call("/device/token", {
        method: "POST",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: CLI_CLIENT_ID,
        },
      }),
    );

  /** Skips the polling interval instead of waiting 5 s. */
  const rewindPoll = (deviceCode: string) =>
    d1.db
      .prepare("UPDATE device_codes SET last_polled_at = 0 WHERE device_code = ?")
      .bind(deviceCode)
      .run();

  /** Web user approves the code; returns the CLI's bearer token. */
  async function login(jar: CookieJar) {
    const code = await startDeviceFlow();
    expect(await pollToken(code.device_code)).toMatchObject({ error: "authorization_pending" });

    // The /device page looks the code up first, which ties it to the signed-in user.
    const verify = await call(`/device?user_code=${code.user_code}`, { jar });
    expect(await json(verify)).toMatchObject({ status: "pending" });

    const approve = await call("/device/approve", {
      method: "POST",
      body: { userCode: code.user_code },
      jar,
    });
    expect(approve.status).toBe(200);

    await rewindPoll(code.device_code);
    const token = await pollToken(code.device_code);
    expect(token.token_type).toBe("Bearer");
    return token.access_token ?? "";
  }

  it("issues a verification URL on the site", async () => {
    const code = await startDeviceFlow();
    expect(code.verification_uri).toBe(`${BASE}/device`);
    expect(code.user_code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it("only serves the zerosnake CLI client", async () => {
    const res = await call("/device/code", { method: "POST", body: { client_id: "other" } });
    expect(res.status).toBe(400);
  });

  it("gives the CLI a bearer token marked as a CLI session", async () => {
    const jar = await signUp(ada);
    const token = await login(jar);

    const session = await getSession({ bearer: token });
    expect(session?.user.email).toBe("ada@example.com");
    expect(session?.session.kind).toBe("cli");
  });

  it("needs a username before the CLI can be approved", async () => {
    const jar = await signInWithGithub(ada);
    const code = await startDeviceFlow();
    await call(`/device?user_code=${code.user_code}`, { jar });
    const res = await call("/device/approve", {
      method: "POST",
      body: { userCode: code.user_code },
      jar,
    });
    expect(res.status).toBe(403);
  });

  it("returns access_denied when the user denies", async () => {
    const jar = await signUp(ada);
    const code = await startDeviceFlow();
    await call(`/device?user_code=${code.user_code}`, { jar });
    await call("/device/deny", { method: "POST", body: { userCode: code.user_code }, jar });
    expect(await pollToken(code.device_code)).toMatchObject({ error: "access_denied" });
  });
});

describe("CLI tokens", () => {
  async function loginCli(jar: CookieJar) {
    const code = await json<{ device_code: string; user_code: string }>(
      await call("/device/code", { method: "POST", body: { client_id: CLI_CLIENT_ID } }),
    );
    await call(`/device?user_code=${code.user_code}`, { jar });
    await call("/device/approve", { method: "POST", body: { userCode: code.user_code }, jar });
    const res = await call("/device/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: CLI_CLIENT_ID,
      },
    });
    return (await json<{ access_token: string }>(res)).access_token;
  }

  const list = async (auth: CallOptions) => {
    const res = await call("/cli-tokens/list", auth);
    expect(res.status).toBe(200);
    return json<CliToken[]>(res);
  };

  it("lists only CLI sessions, without the secret token", async () => {
    const jar = await signUp(ada);
    await loginCli(jar);
    await loginCli(jar);

    const tokens = await list({ jar });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ userAgent: "vitest", current: false });
    expect(tokens[0]).not.toHaveProperty("token");
  });

  it("revokes a token so the CLI is signed out", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    const [listed] = await list({ jar });

    const res = await call("/cli-tokens/revoke", { method: "POST", body: { id: listed?.id }, jar });
    expect(res.status).toBe(200);
    expect(await getSession({ bearer: token })).toBeNull();
    expect(await list({ jar })).toEqual([]);
  });

  it("lets the CLI see and revoke its own token", async () => {
    const jar = await signUp(ada);
    const token = await loginCli(jar);
    const [self] = await list({ bearer: token });
    expect(self?.current).toBe(true);

    await call("/cli-tokens/revoke", { method: "POST", body: { id: self?.id }, bearer: token });
    expect(await getSession({ bearer: token })).toBeNull();
  });

  it("does not revoke web sessions or other users' tokens", async () => {
    const adaJar = await signUp(ada);
    const adaToken = await loginCli(adaJar);
    const [adaCli] = await list({ jar: adaJar });
    const adaWeb = (await getSession({ jar: adaJar }))?.session.id;

    const bobJar = await signUp(bob);
    for (const id of [adaCli?.id, adaWeb]) {
      const res = await call("/cli-tokens/revoke", { method: "POST", body: { id }, jar: bobJar });
      expect(res.status).toBe(404);
    }
    const own = await call("/cli-tokens/revoke", {
      method: "POST",
      body: { id: adaWeb },
      jar: adaJar,
    });
    expect(own.status).toBe(404);

    expect((await getSession({ bearer: adaToken }))?.user.email).toBe("ada@example.com");
    expect((await getSession({ jar: adaJar }))?.user.email).toBe("ada@example.com");
  });

  it("requires a session", async () => {
    expect((await call("/cli-tokens/list")).status).toBe(401);
  });
});
