/**
 * The rating job (Cron Trigger, `RATINGS_CRON` in `src/server.ts`): keeps `ratings` up to date
 * with `lives`, using `@zerosnake/rating`. Decoupled from the arena, which only inserts `lives`
 * rows; nothing else writes ratings (a rollback deletes one, `src/server/bot-admin.ts`).
 *
 * **Cursor.** Triggers number every finished life (`lives.seq`, migration `0007_rating_job`) in
 * commit order, so lives the arena writes late (after the replay chunk is uploaded, or after a
 * retry) simply come later in the order. Each run reads lives with `seq > rating_progress.rated_seq`
 * in batches, adds each counted one to its version's rating, and moves the cursor in the same D1
 * transaction as the rating writes. Every commit is guarded by `rating_progress.rev` (and bumps
 * it), so overlapping runs never interleave: the second to commit changes nothing, rereads and
 * carries on from where the first got to.
 *
 * **Counted lives** (SPEC §4, `src/shared/arena.ts`): lives of the version's current stint, i.e.
 * started at or after `versions.activated_at` (all of them while it's `null`), and not ended by
 * the platform (`retired` short of a life cap: version rolled back, archived or banned, arena
 * paused; `src/shared/lives.ts`). A life that reached the cap counts. Each adds its score and its
 * length (`end_tick − start_tick`): the rating is points per minute alive. A rating needs two
 * counted lives (there's no interval with one); it is written with the `activated_at` it counted
 * from, so the stint triggers ignore a write that raced a rollback.
 *
 * **Idempotent.** `ratings.life_seq` says which lives a rating already covers; a life with a
 * smaller `seq` is never added again, so a cursor moved back, a replayed batch or a rebuild that
 * got ahead of the cursor count every life once.
 *
 * **Format.** `rating_progress.format` says what the ratings are: 1 means per life (before long
 * lives), 2 points per minute. A run that finds 1 first deletes every rating and moves the cursor
 * back to 0 (`resetFormat`), so they are all rebuilt from `lives`, however the old job left them
 * (it runs until this code is deployed, after migration 0014). Then triggers keep a run of the old
 * code that is still in flight out: its cursor moves (`job_rev` not set) and its version-1
 * windows are ignored, and a version-1 row that got in anyway is rebuilt (marked, below).
 *
 * **Rebuilds.** A row whose state can't be continued (none yet, `life_seq` null, another stint,
 * a window scored differently or in the old per-life format) is rebuilt from `lives`: the last 200
 * counted lives, and the count and total length of all of them.
 * Setting `life_seq = NULL` asks for a rebuild; each run does up to `rebuildsPerRun` of those. To
 * rebuild by hand (wrangler `d1 execute DB --remote --env staging --command "..."`):
 *
 * ```sql
 * -- one version's rating, or every rating
 * UPDATE ratings SET life_seq = NULL WHERE version_id = '<id>';
 * UPDATE ratings SET life_seq = NULL;
 * -- also versions that have no row: replay every life (each is still counted once)
 * UPDATE rating_progress SET rated_seq = 0 WHERE id = 1;
 * ```
 *
 * **Bad scores.** A life whose score `@zerosnake/rating` can't take (not a finite number within
 * ±`MAX_LIFE_SCORE`) isn't counted: the run logs `ratings.life_skipped` with its id and carries
 * on, and rebuilds leave it out, so one bad row never stops the cursor.
 *
 * **Bounded.** A run reads at most `maxLives` lives (`batchLives` per query) and makes a handful
 * of D1 queries per batch (Workers allow 1000 per invocation); what's left waits for the next
 * run, a minute later. Every run logs `ratings.updated` with the backlog.
 */
import { log } from "@zerosnake/observability";
import {
  addLife,
  createRatingState,
  DEFAULT_RATING_CONFIG,
  fromRatingsRow,
  MAX_LIFE_SCORE,
  MAX_LIFE_TICKS,
  type RatedLife,
  type RatingConfig,
  type RatingState,
  toRatingsRow,
} from "@zerosnake/rating";
import { COUNTED_ENDING_SQL, reachedLifeCap, type StoredDeathCause } from "../shared/lives";

export interface RatingJobEnv {
  DB: D1Database;
}

export interface RatingJobOptions {
  /** Lives read per query. */
  batchLives?: number;
  /** Lives read per run; the rest wait for the next run. */
  maxLives?: number;
  /**
   * Ratings marked for a rebuild (`life_seq IS NULL`, or a version-1 window: the old per-life
   * format) rebuilt per run.
   */
  rebuildsPerRun?: number;
  config?: RatingConfig;
}

export interface RatingJobResult {
  /** Lives read (counted or not). */
  lives: number;
  /** Ratings written or deleted. */
  ratings: number;
  /** Marked ratings rebuilt. */
  rebuilt: number;
  /** Lives up to this `seq` are applied. */
  ratedSeq: number;
  /** Lives finished so far; `assignedSeq - ratedSeq` is the backlog. */
  assignedSeq: number;
  /** Whether work was left for the next run. */
  more: boolean;
}

/** The rating job's Cron Trigger; `triggers.crons` in wrangler.jsonc must list it (a test checks). */
export const RATINGS_CRON = "* * * * *";

export const RATING_JOB_DEFAULTS = {
  batchLives: 1000,
  maxLives: 20_000,
  rebuildsPerRun: 50,
} as const;

/** Keeps each JSON parameter well under D1's statement and value size limits. */
const MAX_JSON_PARAM = 90_000;

/** Commits that lost the `rev` race in a row before a run gives up (another run is working). */
const MAX_CONFLICTS = 3;

interface Progress {
  ratedSeq: number;
  assignedSeq: number;
  rev: number;
  /** `rating_progress.format`: 1 per-life ratings (to reset), 2 points per minute. */
  format: number;
}

/** `rating_progress.format` of points-per-minute ratings. */
export const RATINGS_FORMAT = 2;

interface LifeRow {
  id: string;
  seq: number;
  version_id: string;
  score: number;
  start_tick: number;
  end_tick: number;
  started_at: number;
  death_cause: StoredDeathCause | null;
}

/** A version and its current rating row, if any. */
interface Current {
  versionId: string;
  activatedAt: number | null;
  row: {
    activatedAt: number | null;
    nLives: number;
    aliveTicks: number;
    recentScores: string | null;
    lifeSeq: number | null;
  } | null;
}

/** A rating to upsert, as one element of the JSON parameter. */
interface RatingWrite {
  id: string;
  activatedAt: number | null;
  mean: number;
  /** `null` without an interval (fewer than two lives' worth, `MIN_EFFECTIVE_LIVES`). */
  ci: number | null;
  nLives: number;
  aliveTicks: number;
  recentScores: string;
  lifeSeq: number;
}

interface Changes {
  writes: RatingWrite[];
  /** Rows to delete: rebuilt with fewer than two counted lives. */
  deletes: string[];
}

/** One run of the job: apply new lives, then some rebuilds. Throws on D1 errors. */
export async function updateRatings(
  db: D1Database,
  now: Date,
  options: RatingJobOptions = {},
): Promise<RatingJobResult> {
  const { batchLives, maxLives, rebuildsPerRun } = { ...RATING_JOB_DEFAULTS, ...options };
  const config = options.config ?? DEFAULT_RATING_CONFIG;
  let progress = await resetFormat(db, await readProgress(db), now);
  let lives = 0;
  let ratings = 0;
  let conflicts = 0;
  let caughtUp = false;

  while (lives < maxLives && conflicts < MAX_CONFLICTS) {
    const limit = Math.min(batchLives, maxLives - lives);
    const { results: batch } = await db
      .prepare(
        `SELECT id, seq, version_id, score, start_tick, end_tick, started_at, death_cause
         FROM lives WHERE seq > ?1 ORDER BY seq LIMIT ?2`,
      )
      .bind(progress.ratedSeq, limit)
      .all<LifeRow>();
    const last = batch.at(-1);
    if (!last) {
      caughtUp = true;
      break;
    }
    const through = last.seq;
    const changes = await applyLives(db, batch, through, config);
    const committed = await commit(db, changes, progress.rev, through, now);
    if (!committed) {
      conflicts++;
      progress = await readProgress(db);
      continue;
    }
    conflicts = 0;
    progress = { ...progress, ...committed };
    lives += batch.length;
    ratings += changes.writes.length + changes.deletes.length;
    if (batch.length < limit) {
      caughtUp = true;
      break;
    }
  }

  // Marked rows, rebuilt up to the cursor (later lives are added by later batches).
  let rebuilt = 0;
  let rebuildsLeft = false;
  if (conflicts < MAX_CONFLICTS && rebuildsPerRun > 0) {
    const { results: marked } = await db
      .prepare(
        `SELECT version_id FROM ratings
         WHERE life_seq IS NULL OR json_extract(recent_scores, '$.v') = 1 LIMIT ?1`,
      )
      .bind(rebuildsPerRun)
      .all<{ version_id: string }>();
    if (marked.length > 0) {
      const ids = marked.map((r) => r.version_id);
      const current = await readCurrent(db, ids);
      const changes = await rebuild(db, [...current.values()], progress.ratedSeq, config);
      const committed = await commit(db, changes, progress.rev, progress.ratedSeq, now);
      if (committed) {
        progress = { ...progress, ...committed };
        rebuilt = ids.length;
        ratings += changes.writes.length + changes.deletes.length;
      }
      rebuildsLeft = marked.length === rebuildsPerRun || !committed;
    }
  }

  const { assignedSeq } = await readProgress(db);
  return {
    lives,
    ratings,
    rebuilt,
    ratedSeq: progress.ratedSeq,
    assignedSeq,
    more: !caughtUp || rebuildsLeft,
  };
}

/**
 * Rebuilds the ratings of `versionIds` from their lives now, up to the job's cursor (lives
 * after it are added by the job as usual). For tests and one-off repairs; marking rows
 * (`life_seq = NULL`) does the same through the job. Returns `false` if a concurrent run of the
 * job committed first (nothing was written; try again).
 */
export async function rebuildRatings(
  db: D1Database,
  versionIds: readonly string[],
  now: Date,
  config: RatingConfig = DEFAULT_RATING_CONFIG,
): Promise<boolean> {
  const progress = await readProgress(db);
  const current = await readCurrent(db, versionIds);
  const changes = await rebuild(db, [...current.values()], progress.ratedSeq, config);
  return (await commit(db, changes, progress.rev, progress.ratedSeq, now)) !== null;
}

/** The Cron Trigger's job: update, log. Never throws (a failure is logged). */
export async function runRatingJob(env: RatingJobEnv, now: Date, options?: RatingJobOptions) {
  const started = Date.now();
  try {
    const result = await updateRatings(env.DB, now, options);
    log("info", "ratings.updated", {
      ...result,
      backlog: result.assignedSeq - result.ratedSeq,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    log("error", "ratings.update_failed", { error, durationMs: Date.now() - started });
    return null;
  }
}

/** Whether `@zerosnake/rating` can take the life (it throws a `RangeError` otherwise). */
function ratable(life: Pick<LifeRow, "score" | "start_tick" | "end_tick">): boolean {
  const ticks = life.end_tick - life.start_tick;
  return (
    typeof life.score === "number" &&
    Math.abs(life.score) <= MAX_LIFE_SCORE &&
    Number.isInteger(ticks) &&
    ticks >= 0 &&
    ticks <= MAX_LIFE_TICKS
  );
}

/** The life as the rating takes it: its score and length. */
function ratedLife(life: Pick<LifeRow, "score" | "start_tick" | "end_tick">): RatedLife {
  return { score: life.score, ticks: life.end_tick - life.start_tick };
}

/** Whether a life counts toward its version's rating in the stint that began at `activatedAt`. */
export function countsToward(
  life: Pick<LifeRow, "started_at" | "death_cause" | "start_tick" | "end_tick">,
  activatedAt: number | null,
): boolean {
  const ended =
    life.death_cause !== "retired" ||
    reachedLifeCap(life.death_cause, life.end_tick - life.start_tick);
  return ended && (activatedAt === null || life.started_at >= activatedAt);
}

// ─── Steps ──────────────────────────────────────────────────────────────────────────────────────

/** The rating changes for one batch of lives, all with `seq <= through`. */
async function applyLives(
  db: D1Database,
  batch: LifeRow[],
  through: number,
  config: RatingConfig,
): Promise<Changes> {
  const byVersion = new Map<string, LifeRow[]>();
  for (const life of batch) {
    if (!ratable(life)) {
      // Rebuilds leave it out too (see `rebuild`), so skipping it here is all it takes.
      log("warn", "ratings.life_skipped", {
        lifeId: life.id,
        versionId: life.version_id,
        seq: life.seq,
        score: String(life.score),
        ticks: String(life.end_tick - life.start_tick),
      });
      continue;
    }
    const list = byVersion.get(life.version_id);
    if (list) list.push(life);
    else byVersion.set(life.version_id, [life]);
  }
  const current = await readCurrent(db, [...byVersion.keys()]);
  const writes: RatingWrite[] = [];
  const stale: Current[] = [];
  for (const [versionId, versionLives] of byVersion) {
    const c = current.get(versionId);
    if (!c) continue; // deleted with its bot or account
    const state = continuable(c, config);
    if (!state) {
      stale.push(c);
      continue;
    }
    const after = c.row?.lifeSeq ?? 0;
    let next: RatingState = state;
    for (const life of versionLives) {
      if (life.seq > after && countsToward(life, c.activatedAt)) {
        next = addLife(next, ratedLife(life), config);
      }
    }
    // Nothing counted: leave the row (and its `life_seq`) as it is.
    if (next !== state) writes.push(toWrite(c, next, through, config));
  }
  const rebuilt = await rebuild(db, stale, through, config);
  return { writes: [...writes, ...rebuilt.writes], deletes: rebuilt.deletes };
}

/** The stored state if it can be continued, else `null` (rebuild from `lives`). */
function continuable(c: Current, config: RatingConfig): RatingState | null {
  const row = c.row;
  if (!row || row.lifeSeq === null || row.recentScores === null) return null;
  if (row.activatedAt !== c.activatedAt) return null;
  try {
    return fromRatingsRow(
      { nLives: row.nLives, aliveTicks: row.aliveTicks, recentScores: row.recentScores },
      config,
    );
  } catch {
    return null; // a corrupt window: rebuild it
  }
}

/** Ratings of `targets` recomputed from their counted lives with `seq <= through`. */
async function rebuild(
  db: D1Database,
  targets: Current[],
  through: number,
  config: RatingConfig,
): Promise<Changes> {
  const changes: Changes = { writes: [], deletes: [] };
  if (targets.length === 0) return changes;
  const found = new Map<string, { lives: RatedLife[]; n: number; ticks: number }>();
  for (const chunk of jsonChunks(targets.map((t) => ({ id: t.versionId, from: t.activatedAt })))) {
    // The last `window` counted lives of each version, oldest first, with how many it has and
    // how long they lasted in all (each at least a tick, as `@zerosnake/rating` counts them).
    // Lives `ratable` rejects are left out (text sorts above every number in SQLite).
    const { results } = await db
      .prepare(
        `SELECT version_id, score, ticks, n, total FROM (
           SELECT l.version_id, l.score, l.seq, l.end_tick - l.start_tick AS ticks,
             row_number() OVER (PARTITION BY l.version_id ORDER BY l.seq DESC) AS k,
             count(*) OVER (PARTITION BY l.version_id) AS n,
             sum(max(1, l.end_tick - l.start_tick)) OVER (PARTITION BY l.version_id) AS total
           FROM json_each(?1) AS t
           JOIN lives AS l ON l.version_id = t.value ->> '$.id'
           WHERE l.seq <= ?2
             AND l.started_at >= coalesce(t.value ->> '$.from', 0)
             AND ${COUNTED_ENDING_SQL}
             AND l.score BETWEEN -?4 AND ?4
             AND l.end_tick - l.start_tick BETWEEN 0 AND ?5
         )
         WHERE k <= ?3 ORDER BY version_id, seq`,
      )
      .bind(chunk, through, config.window, MAX_LIFE_SCORE, MAX_LIFE_TICKS)
      .all<{ version_id: string; score: number; ticks: number; n: number; total: number }>();
    for (const r of results) {
      const life = { score: r.score, ticks: r.ticks };
      const s = found.get(r.version_id);
      if (s) s.lives.push(life);
      else found.set(r.version_id, { lives: [life], n: r.n, ticks: r.total });
    }
  }
  for (const t of targets) {
    const s = found.get(t.versionId);
    if (s && s.n >= 2) {
      const state = createRatingState(s.lives, s.n, s.ticks, config);
      changes.writes.push(toWrite(t, state, through, config));
    } else if (t.row) {
      changes.deletes.push(t.versionId);
    }
  }
  return changes;
}

function toWrite(
  c: Current,
  state: RatingState,
  through: number,
  config: RatingConfig,
): RatingWrite {
  const row = toRatingsRow(state, config);
  return {
    id: c.versionId,
    activatedAt: c.activatedAt,
    mean: row.mean,
    ci: row.ci,
    nLives: row.nLives,
    aliveTicks: row.aliveTicks,
    recentScores: row.recentScores,
    lifeSeq: through,
  };
}

/**
 * Writes `changes` and moves the cursor to `ratedSeq`, in one transaction, if `rev` is still
 * the current one. Returns the new progress, or `null` when another run committed first (and
 * nothing was written).
 */
async function commit(
  db: D1Database,
  changes: Changes,
  rev: number,
  ratedSeq: number,
  now: Date,
): Promise<Pick<Progress, "ratedSeq" | "rev"> | null> {
  const t = now.getTime();
  const guard = "(SELECT rev FROM rating_progress WHERE id = 1) = ?2";
  const statements: D1PreparedStatement[] = [];
  for (const chunk of jsonChunks(changes.writes)) {
    // The join skips versions deleted since they were read (the foreign key would fail the
    // whole batch). The stint triggers ignore rows whose `activated_at` is no longer current.
    statements.push(
      db
        .prepare(
          `INSERT INTO ratings
             (version_id, activated_at, mean, ci, n_lives, alive_ticks, recent_scores, life_seq,
              updated_at)
           SELECT v.id, w.value ->> '$.activatedAt', w.value ->> '$.mean', w.value ->> '$.ci',
             w.value ->> '$.nLives', w.value ->> '$.aliveTicks', w.value ->> '$.recentScores',
             w.value ->> '$.lifeSeq', ?3
           FROM json_each(?1) AS w JOIN versions AS v ON v.id = w.value ->> '$.id'
           WHERE ${guard}
           ON CONFLICT (version_id) DO UPDATE SET activated_at = excluded.activated_at,
             mean = excluded.mean, ci = excluded.ci, n_lives = excluded.n_lives,
             alive_ticks = excluded.alive_ticks, recent_scores = excluded.recent_scores,
             life_seq = excluded.life_seq, updated_at = excluded.updated_at`,
        )
        .bind(chunk, rev, t),
    );
  }
  for (const chunk of jsonChunks(changes.deletes)) {
    statements.push(
      db
        .prepare(
          `DELETE FROM ratings WHERE version_id IN (SELECT value FROM json_each(?1)) AND ${guard}`,
        )
        .bind(chunk, rev),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE rating_progress SET rated_seq = max(rated_seq, ?1), rev = rev + 1,
           job_rev = rev + 1, updated_at = ?3
         WHERE id = 1 AND rev = ?2
         RETURNING rated_seq, rev`,
      )
      .bind(ratedSeq, rev, t),
  );
  const results = await db.batch<{ rated_seq: number; rev: number }>(statements);
  const row = results[results.length - 1]?.results[0];
  return row ? { ratedSeq: row.rated_seq, rev: row.rev } : null;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────────────

async function readProgress(db: D1Database): Promise<Progress> {
  const row = await db
    .prepare("SELECT rated_seq, assigned_seq, rev, format FROM rating_progress WHERE id = 1")
    .first<{ rated_seq: number; assigned_seq: number; rev: number; format: number }>();
  if (!row) throw new Error("rating_progress has no row: run the D1 migrations");
  return {
    ratedSeq: row.rated_seq,
    assignedSeq: row.assigned_seq,
    rev: row.rev,
    format: row.format,
  };
}

/**
 * Ratings in an older format (`rating_progress.format` below `RATINGS_FORMAT`: means per life)
 * are all deleted and the cursor goes back to 0, in one transaction guarded by `rev`, so the job
 * replays every life into new ratings. Whatever the old job wrote or skipped before this code was
 * deployed is gone with it; the triggers of migration 0014 keep it out afterwards. Returns the
 * progress to carry on from.
 */
async function resetFormat(db: D1Database, progress: Progress, now: Date): Promise<Progress> {
  if (progress.format >= RATINGS_FORMAT) return progress;
  const guard = "(SELECT rev FROM rating_progress WHERE id = 1) = ?1";
  await db.batch([
    db.prepare(`DELETE FROM ratings WHERE ${guard}`).bind(progress.rev),
    db
      .prepare(
        `UPDATE rating_progress SET format = ?2, rated_seq = 0, rev = rev + 1, job_rev = rev + 1,
           updated_at = ?3
         WHERE id = 1 AND rev = ?1`,
      )
      .bind(progress.rev, RATINGS_FORMAT, now.getTime()),
  ]);
  const after = await readProgress(db);
  if (after.format >= RATINGS_FORMAT) {
    log("info", "ratings.format_reset", { format: after.format, rev: after.rev });
  }
  return after;
}

/** `versionIds` that still exist, with their rating rows. */
async function readCurrent(
  db: D1Database,
  versionIds: readonly string[],
): Promise<Map<string, Current>> {
  const current = new Map<string, Current>();
  for (const chunk of jsonChunks(versionIds)) {
    const { results } = await db
      .prepare(
        `SELECT v.id, v.activated_at, r.version_id AS rated, r.activated_at AS r_activated_at,
           r.n_lives, r.alive_ticks, r.recent_scores, r.life_seq
         FROM json_each(?1) AS j JOIN versions AS v ON v.id = j.value
         LEFT JOIN ratings AS r ON r.version_id = v.id`,
      )
      .bind(chunk)
      .all<{
        id: string;
        activated_at: number | null;
        rated: string | null;
        r_activated_at: number | null;
        n_lives: number | null;
        alive_ticks: number | null;
        recent_scores: string | null;
        life_seq: number | null;
      }>();
    for (const r of results) {
      current.set(r.id, {
        versionId: r.id,
        activatedAt: r.activated_at,
        row:
          r.rated === null
            ? null
            : {
                activatedAt: r.r_activated_at,
                nLives: r.n_lives ?? 0,
                aliveTicks: r.alive_ticks ?? 0,
                recentScores: r.recent_scores,
                lifeSeq: r.life_seq,
              },
      });
    }
  }
  return current;
}

/** `items` as JSON arrays of at most `MAX_JSON_PARAM` characters each. */
function* jsonChunks(items: readonly unknown[]): Generator<string> {
  let parts: string[] = [];
  let size = 2;
  for (const item of items) {
    const json = JSON.stringify(item);
    if (parts.length > 0 && size + json.length + 1 > MAX_JSON_PARAM) {
      yield `[${parts.join(",")}]`;
      parts = [];
      size = 2;
    }
    parts.push(json);
    size += json.length + 1;
  }
  if (parts.length > 0) yield `[${parts.join(",")}]`;
}
