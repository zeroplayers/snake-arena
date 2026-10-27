import { env } from "cloudflare:workers";
import { createDb, type Db } from "../db";
import { type Account, createAccount } from "./account";
import { type Auth, createAuth } from "./auth";
import { type BotAdmin, callMatchmaker, createBotAdmin, matchmakerNotifier } from "./bot-admin";
import { type CliApi, createCliApi } from "./cli-api";
import { createModeration, type Moderation } from "./moderation";
import { createRateLimiter, type RateLimiter } from "./rate-limit";

let auth: Auth | undefined;
let db: Db | undefined;
let cliApi: CliApi | undefined;
let botAdmin: BotAdmin | undefined;
let moderation: Moderation | undefined;
let rateLimiter: RateLimiter | undefined;
let account: Account | undefined;

/** The Worker's Better Auth instance, built on first use from `env`. */
export function getAuth() {
  auth ??= createAuth(env);
  return auth;
}

export function getDb() {
  db ??= createDb(env.DB);
  return db;
}

export function getRateLimiter() {
  rateLimiter ??= createRateLimiter(env);
  return rateLimiter;
}

export function getCliApi() {
  cliApi ??= createCliApi(env, { rateLimiter: getRateLimiter() });
  return cliApi;
}

export function getBotAdmin() {
  botAdmin ??= createBotAdmin(env, {
    getSession: (input) => getAuth().api.getSession(input),
    notify: matchmakerNotifier(env.MATCHMAKER),
    rateLimiter: getRateLimiter(),
  });
  return botAdmin;
}

export function getModeration() {
  moderation ??= createModeration(env, {
    getSession: (input) => getAuth().api.getSession(input),
    notify: matchmakerNotifier(env.MATCHMAKER),
    notifyControl: (control) =>
      callMatchmaker(env.MATCHMAKER, (stub) => stub.arenaControlChanged(control), control),
    rateLimiter: getRateLimiter(),
  });
  return moderation;
}

export function getAccount() {
  account ??= createAccount(env, {
    getSession: (input) => getAuth().api.getSession(input),
    notify: matchmakerNotifier(env.MATCHMAKER),
    rateLimiter: getRateLimiter(),
  });
  return account;
}
