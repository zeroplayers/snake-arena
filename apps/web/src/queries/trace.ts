/**
 * Life traces (`src/shared/trace.ts`) for their owners: the CLI API (`GET /api/lives/:id/trace`)
 * and the replay page read them through `readLifeTrace`, which checks that the caller owns the
 * life's bot. Nobody else can read a trace, whatever the page or the API: traces hold the
 * author's own `log()` output.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { bots, lives, versions } from "../db/schema";
import type { LifeSummary, LifeTrace, TraceResponse } from "../shared/trace";
import { type Killer, killer, killerBot, killerUser, killerVersion, type LifeRow } from "./bot";

/** A trace with its killer named for people. */
export type OwnTrace = TraceResponse;

export type TraceRead =
  | { status: "ok"; trace: OwnTrace }
  /** No such life. */
  | { status: "not_found" }
  /** The life is someone else's bot's. */
  | { status: "forbidden" }
  /** No trace was recorded for it. */
  | { status: "none" }
  /** Recorded, but deleted after `TRACE_RETENTION_DAYS`. */
  | { status: "expired" };

/** The trace of `lifeId`, if `userId` owns its bot. */
export async function readLifeTrace(
  db: Db,
  bucket: R2Bucket,
  lifeId: string,
  userId: string,
): Promise<TraceRead> {
  const [row] = await db
    .select({
      ownerId: bots.ownerId,
      traceKey: lives.traceKey,
      killer: lives.killer,
      killerAuthor: killerUser.username,
      killerBotName: killerBot.name,
      killerBotSlug: killerBot.slug,
      killerVersion: killerVersion.n,
    })
    .from(lives)
    .innerJoin(versions, eq(versions.id, lives.versionId))
    .innerJoin(bots, eq(bots.id, versions.botId))
    .leftJoin(killerVersion, eq(killerVersion.id, lives.killer))
    .leftJoin(killerBot, eq(killerBot.id, killerVersion.botId))
    .leftJoin(killerUser, eq(killerUser.id, killerBot.ownerId))
    .where(eq(lives.id, lifeId))
    .limit(1);
  if (!row) return { status: "not_found" };
  if (row.ownerId !== userId) return { status: "forbidden" };
  if (!row.traceKey) return { status: "none" };
  const object = await bucket.get(row.traceKey);
  if (!object) return { status: "expired" };
  const text = await new Response(object.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const trace = JSON.parse(text) as LifeTrace;
  return { status: "ok", trace: { ...trace, killerName: killerName(killer(row)) } };
}

/** What the replay page's trace panel gets (`getReplayTrace`). */
export type ReplayTrace =
  | { status: "ok"; trace: OwnTrace }
  /** Not signed in, or not the bot's owner: traces are private. */
  | { status: "private"; signedIn: boolean }
  | { status: "none" }
  | { status: "expired" };

/**
 * The replay page's read of `lifeId`'s trace: for the web session behind `headers` (Better Auth's
 * `api.getSession`; a CLI token is no session), and only if it owns the life's bot.
 */
export async function replayTrace(
  deps: {
    getSession: (input: { headers: Headers }) => Promise<{ user: { id: string } } | null>;
    db: Db;
    bucket: R2Bucket;
  },
  headers: Headers,
  lifeId: string,
): Promise<ReplayTrace> {
  const session = await deps.getSession({ headers });
  if (!session) return { status: "private", signedIn: false };
  const read = await readLifeTrace(deps.db, deps.bucket, lifeId, session.user.id);
  switch (read.status) {
    case "forbidden":
      return { status: "private", signedIn: true };
    case "not_found":
      return { status: "none" };
    default:
      return read;
  }
}

/** How the CLI names a killer. */
export function killerName(k: Killer | null): string | null {
  if (!k) return null;
  if (k.kind === "house") return `house bot ${k.name}`;
  if (k.kind === "bot") return `@${k.author}/${k.botSlug} v${k.version}`;
  return "a deleted bot";
}

/** A bot page life row as the CLI API lists it. */
export function lifeSummary(life: LifeRow): LifeSummary {
  return {
    id: life.id,
    startedAt: life.startedAt,
    endedAt: life.endedAt,
    score: life.score,
    lengthMax: life.lengthMax,
    kills: life.kills,
    deathCause: life.deathCause,
    killer: killerName(life.killer),
    hasTrace: life.hasTrace,
  };
}
