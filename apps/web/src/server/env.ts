import { env } from "cloudflare:workers";
import { createDb, type Db } from "../db";
import { type Auth, createAuth } from "./auth";
import { type BotAdmin, createBotAdmin, matchmakerNotifier } from "./bot-admin";
import { type CliApi, createCliApi } from "./cli-api";

let auth: Auth | undefined;
let db: Db | undefined;
let cliApi: CliApi | undefined;
let botAdmin: BotAdmin | undefined;

/** The Worker's Better Auth instance, built on first use from `env`. */
export function getAuth() {
  auth ??= createAuth(env);
  return auth;
}

export function getDb() {
  db ??= createDb(env.DB);
  return db;
}

export function getCliApi() {
  cliApi ??= createCliApi(env);
  return cliApi;
}

export function getBotAdmin() {
  botAdmin ??= createBotAdmin(env, {
    getSession: (input) => getAuth().api.getSession(input),
    notify: matchmakerNotifier(env.MATCHMAKER),
  });
  return botAdmin;
}
