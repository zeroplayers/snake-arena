import { env } from "cloudflare:workers";
import { createDb, type Db } from "../db";
import { type Auth, createAuth } from "./auth";

let auth: Auth | undefined;
let db: Db | undefined;

/** The Worker's Better Auth instance, built on first use from `env`. */
export function getAuth() {
  auth ??= createAuth(env);
  return auth;
}

export function getDb() {
  db ??= createDb(env.DB);
  return db;
}
