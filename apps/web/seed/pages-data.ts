/**
 * Extra local data for the public pages, on top of `dev.sql`: a real recorded replay (a short
 * match of house bots playing the seed versions, recorded with `ReplayRecorder`), the lives of
 * that match pointing at it, source archives for every seed version, and a few empty cases (an
 * author without bots, a bot without versions).
 *
 * Pure and deterministic: `pages.ts` writes it to the local D1/R2, the query tests load it into
 * a test database.
 */

import {
  buildBotInfo,
  buildBotState,
  createWorld,
  type Death,
  ReplayRecorder,
  type World,
} from "@zerosnake/engine";
import { houseBots } from "@zerosnake/house-bots";
import { type Bot, createTickLog, LOG_LIMIT_BYTES } from "@zerosnake/sdk";

export const REPLAY_ROOM = "seed-replay-room";
export const REPLAY_KEY = "seed/replays/seed-replay-room/0.bin";
/** Game time of the recorded match: two minutes. */
export const REPLAY_TICKS = 1200;
/** After every `dev.sql` life, so these are the newest. */
const T0 = 1768000000000;
const TICK_MS = 100;

interface Player {
  /** Life ids are `seed-replay-{key}-{n}`; house bots have no version. */
  key: string;
  versionId: string | null;
  author: string;
  bot: Bot<object>;
  respawn: boolean;
}

const players: Player[] = [
  { key: "greedy", versionId: "seed-greedy-2", author: "ada", bot: houseBots.hard, respawn: true },
  { key: "coward", versionId: "seed-coward-1", author: "ada", bot: houseBots.easy, respawn: true },
  {
    key: "spiral",
    versionId: "seed-spiral-2",
    author: "linus",
    bot: houseBots.chaos,
    respawn: true,
  },
  {
    key: "hunter",
    versionId: "seed-hunter-1",
    author: "grace",
    bot: houseBots.medium,
    respawn: true,
  },
  { key: "medium", versionId: null, author: "house", bot: houseBots.medium, respawn: false },
  { key: "hard", versionId: null, author: "house", bot: houseBots.hard, respawn: true },
  { key: "chaos", versionId: null, author: "house", bot: houseBots.chaos, respawn: true },
  { key: "easy", versionId: null, author: "house", bot: houseBots.easy, respawn: true },
];

export interface SeedLife {
  id: string;
  versionId: string;
  startTick: number;
  death: Death | null;
  score: number;
  maxMass: number;
}

export interface SeedReplay {
  chunks: Uint8Array[];
  lives: SeedLife[];
}

const RESPAWN_DELAY = 30;

/** Plays the match and records it, as RoomDO would. */
export function recordSeedReplay(): SeedReplay {
  // A small arena, so a two-minute match has a few deaths to look at.
  const world = createWorld({ seed: 2026, config: { arenaHalfSize: 49 } });
  const chunks: Uint8Array[] = [];
  // One chunk for the whole match.
  const recorder = new ReplayRecorder(world, {
    chunkTicks: REPLAY_TICKS,
    onChunk: (bytes) => chunks.push(bytes),
  });
  const lives: SeedLife[] = [];
  const running = new Map<string, { player: Player; mem: object; life: SeedLife | null }>();
  const counts = new Map<string, number>();
  const respawnAt = new Map<Player, number>(players.map((p) => [p, 0]));
  const log = createTickLog();

  const spawnDue = (w: World) => {
    for (const player of players) {
      const at = respawnAt.get(player);
      if (at === undefined || w.tick < at) continue;
      respawnAt.delete(player);
      const n = (counts.get(player.key) ?? 0) + 1;
      counts.set(player.key, n);
      const id = player.versionId ? `seed-replay-${player.key}-${n}` : `house:${player.key}#${n}`;
      const snake = recorder.spawn({ id, author: player.author });
      const mem =
        player.bot.init?.(
          buildBotInfo(w, snake, { opBudget: 100_000, logLimitBytes: LOG_LIMIT_BYTES }),
        ) ?? {};
      const life = player.versionId
        ? { id, versionId: player.versionId, startTick: w.tick, death: null, score: 0, maxMass: 0 }
        : null;
      if (life) lives.push(life);
      running.set(id, { player, mem, life });
    }
  };

  spawnDue(world);
  while (world.tick < REPLAY_TICKS) {
    const actions: Record<string, { turn: number; boost?: boolean }> = {};
    for (const snake of world.snakes) {
      const r = running.get(snake.id);
      if (!r) continue;
      actions[snake.id] = r.player.bot.tick(buildBotState(world, snake), r.mem, log.log);
      log.flush();
    }
    recorder.step(actions);
    for (const death of world.deaths) {
      const r = running.get(death.id);
      running.delete(death.id);
      if (!r) continue;
      if (r.life) {
        r.life.death = death;
        r.life.score = death.score;
        r.life.maxMass = death.maxMass;
      }
      if (r.player.respawn) respawnAt.set(r.player, world.tick + RESPAWN_DELAY);
    }
    spawnDue(world);
  }
  for (const snake of world.snakes) {
    const life = running.get(snake.id)?.life;
    if (life) {
      life.score = snake.score;
      life.maxMass = snake.maxMass;
    }
  }
  recorder.flush();
  return { chunks, lives };
}

/** Life id of a death's killer as `lives.killer` stores it: a version id or `house:<name>`. */
function killerColumn(death: Death, lives: readonly SeedLife[]): string | null {
  if (!death.killerId) return null;
  if (death.killerId.startsWith("house:")) return death.killerId.replace(/#\d+$/, "");
  return lives.find((l) => l.id === death.killerId)?.versionId ?? null;
}

const q = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`;

/** Seed versions and the bot code shown on the bot page. */
const SOURCES: Record<string, string> = {
  "seed-greedy-1": `export default defineBot({
  tick(state) {
    const food = nearestFood(state);
    return { turn: food ? steerToward(state.self, food) : 0 };
  },
});`,
  "seed-greedy-2": `// v2: same as v1, but stay away from the wall.
// Escaped on the site, never rendered: <script>alert("not run")</script>
export default defineBot({
  init: () => ({ ticks: 0 }),
  tick(state, mem, log) {
    mem.ticks++;
    if (state.wallDistance < 8) {
      log("wall at", state.wallDistance.toFixed(1));
      return { turn: steerToward(state.self, CENTER) };
    }
    const food = nearestFood(state);
    return { turn: food ? steerToward(state.self, food) : 0, boost: mem.ticks % 50 === 0 };
  },
});`,
  "seed-coward-1": `export default defineBot({
  tick(state) {
    const danger = nearestDanger(state);
    if (danger && danger.distance < 10) return { turn: steerAway(state.self, danger.point) };
    const food = nearestFood(state);
    return { turn: food ? steerToward(state.self, food) : 0.2 };
  },
});`,
  "seed-spiral-1": `export default defineBot({
  tick() {
    while (true) {} // rejected: never returns
  },
});`,
  "seed-spiral-2": `export default defineBot({
  init: () => ({ t: 0 }),
  tick(state, mem) {
    mem.t++;
    return { turn: Math.sin(mem.t / 20) };
  },
});`,
  "seed-hunter-1": `export default defineBot({
  tick(state) {
    const prey = state.snakes.find((s) => s.head && s.length < state.self.length);
    if (prey?.head) return { turn: steerToward(state.self, prey.head), boost: true };
    const food = nearestFood(state);
    return { turn: food ? steerToward(state.self, food) : 0 };
  },
});`,
  "seed-wip-1": `export default defineBot({
  tick: () => ({ turn: 0 }),
});`,
};

const IMPORTS = `import { CENTER, defineBot, nearestDanger, nearestFood, steerAway, steerToward } from "@zerosnake/sdk";\n\n`;

export const sourceKey = (versionId: string) => `seed/sources/${versionId}.json`;

export interface SeedObject {
  bucket: "SOURCES" | "REPLAYS";
  key: string;
  body: Uint8Array | string;
  contentType: string;
}

export interface PagesSeed {
  /** Run after `dev.sql`. */
  statements: string[];
  objects: SeedObject[];
}

export function buildPagesSeed(replay: SeedReplay = recordSeedReplay()): PagesSeed {
  const statements: string[] = [
    // Empty states: an author without bots, a bot without versions.
    `INSERT INTO users (id, name, email, email_verified, image, username, display_username, github_login) VALUES
      ('seed-newbie', 'Newbie', 'newbie@seed.zerosnake.invalid', 1, NULL, 'newbie', 'newbie', 'newbie')`,
    `INSERT INTO bots (id, owner_id, name, slug, skin, created_at) VALUES
      ('seed-draft', 'seed-linus', 'Draft', 'draft', NULL, 1767657600000)`,
  ];
  for (const versionId of Object.keys(SOURCES)) {
    statements.push(
      `UPDATE versions SET source_key = ${q(sourceKey(versionId))} WHERE id = ${q(versionId)}`,
    );
  }
  for (const life of replay.lives) {
    const d = life.death;
    const killer = d ? killerColumn(d, replay.lives) : null;
    statements.push(
      `INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, length_max, kills,
                          death_cause, killer, replay_key, trace_key, started_at, ended_at)
       VALUES (${[
         q(life.id),
         q(life.versionId),
         q(REPLAY_ROOM),
         life.startTick,
         d ? d.tick : null,
         Math.round(life.score),
         Math.round(life.maxMass),
         d?.kills ?? 0,
         d ? q(d.cause) : null,
         q(killer),
         q(REPLAY_KEY),
         null,
         T0 + life.startTick * TICK_MS,
         d ? T0 + d.tick * TICK_MS : null,
       ]
         .map((v) => (typeof v === "string" ? v : q(v)))
         .join(", ")})`,
    );
  }

  const objects: SeedObject[] = Object.entries(SOURCES).map(([versionId, bot]) => ({
    bucket: "SOURCES",
    key: sourceKey(versionId),
    contentType: "application/json",
    body: JSON.stringify({
      format: "zerosnake-sources@1",
      files: [
        { path: "package.json", content: `{ "name": "${versionId}", "type": "module" }\n` },
        { path: "src/bot.ts", content: `${IMPORTS}${bot}\n` },
      ],
    }),
  }));
  const [chunk] = replay.chunks;
  if (chunk) {
    objects.push({
      bucket: "REPLAYS",
      key: REPLAY_KEY,
      contentType: "application/octet-stream",
      body: chunk,
    });
  }
  return { statements, objects };
}
