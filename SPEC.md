# ZeroSnake Arena — Spec v0.1

An arena where people vibe-code slither.io-style snake bots, deploy them with one command, and the bots play each other around the clock in persistent rooms. Everything is open source.

---

## 1. Decisions

| Topic         | Decision                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mechanics     | slither.io: continuous field, rate-limited turning, boost costs length                                                       |
| Arena format  | persistent rooms (fixed-length rounds are the fallback if ratings turn out too noisy)                                        |
| Vision        | only a radius around the head                                                                                                |
| Bot memory    | kept between ticks, reset between lives                                                                                      |
| Languages     | JS / TS                                                                                                                      |
| Code delivery | CLI `npx zerosnake deploy` (no git server)                                                                                   |
| Hosting       | Cloudflare, Workers Paid                                                                                                     |
| Stack         | TanStack Start, Better Auth, D1, R2, Durable Objects, Queues                                                                 |
| Openness      | everything open source: engine, SDK, CLI, site, template, house bots                                                         |
| Graphics      | reused from the original ZeroSnake game (our own project)                                                                    |
| Domain        | `*.surninsynergy.dev` subdomains for staging for now; final domain TBD (candidate: zerosnake.io, appears to be unregistered) |

---

## 2. User journey

```
npx zerosnake init my-snake          # template: src/bot.ts, SDK, CLAUDE.md, skills, tests
cd my-snake && claude                # vibe-code a strategy
npx zerosnake sim                    # local match vs house bots / your own versions, opens the viewer
npx zerosnake test                   # the same checks the server runs
npx zerosnake login                  # browser device flow (Better Auth)
npx zerosnake deploy                 # bundle → server checks → new version → arena
npx zerosnake logs / replays         # recent lives, causes of death
```

On the site: public profile `/@username`, bots and versions, rating and its history, replays with traces, live arena broadcast.

MCP: `claude mcp add zerosnake https://<domain>/mcp` lets the author's Claude inspect deaths and compare versions on its own.

---

## 3. Game

Based on the original ZeroSnake (growth formulas from `frontend/docs/snake_growth_simulation_guide.md`, `CollisionSystem` / `PlayerSystem` / `FoodSystem` from `server/src/rooms/systems`), rewritten as a **deterministic fixed-step engine**.

- **Tick:** 10 per second (to be tuned on the prototype). All physics is tick-based, no `deltaTime`.
- **Bot action:** `{ turn: -1..1, boost?: boolean }`. Turn rate is limited; boost burns length and drops food.
- **What the bot sees (`state`)**:
  - `self`: head position, angle, length, speed, segments;
  - `snakes[]`: only segments within the vision radius (id, author, length);
  - `food[]` within the radius;
  - distance to the wall;
  - `tick`, `lifeTick`.
- **Death** happens when the snake:
  - hits another snake's body or the wall with its head;
  - meets another head: the smaller snake (by length) dies and the kill goes to the larger; equal length, both die;
  - exceeds the time budget (see §5);
  - throws an exception 3 ticks in a row.

  A dead snake drops food.
- **No immortality:**
  - **life cap:** e.g. 6000 ticks (10 minutes), after which the snake "retires" with its score;
  - **hunger:** length slowly decays, so "circling in a corner" doesn't pay.
- **Life score** = area under the length curve (mean × time) + kill bonus. Final formula to be tuned on house bots.

---

## 4. Arena and rating

### Rooms

- **`MatchmakerDO`** (single, global) holds the queue of pending lives: versions that still have daily quota left.
- **`RoomDO`** is one persistent room with 10–20 snakes.
  - When a snake dies, the room pulls the next life from the queue, provided its author isn't already in the room (anti-collusion). The dead bot's next life goes to the back of the queue.
  - A room always has at least 5 snakes from different authors. If there aren't enough real bots, house bots of varying strength fill the gap.
  - A room closes when only house bots remain and the queue is empty.
  - New rooms open when the queue exceeds a threshold.
- **Accelerated simulation.** Rooms with no spectators run as fast as the CPU allows, not in real time. Only 1–2 showcase rooms on the home page run in real time. Cost therefore scales with the number of lives, not with how long rooms are up.

### Quotas (starting values, all configurable)

|                         | Free |
| ----------------------- | ---- |
| Bots per author         | 3    |
| Active versions per bot | 1    |
| Lives per bot per day   | 100  |
| Deploys per day         | 20   |

### Rating

- A version's rating is the mean score over its last **200 lives**, shown with a confidence interval.
- A version enters the leaderboard after **30 lives**.
- A new version starts unrated. The bot page shows a rating chart across versions.
- If room composition turns out to skew scores too much: normalize by the room's average rating, or switch to rounds with OpenSkill.

---

## 5. Running bot code (the key technical risk)

Workers don't allow `eval` or `new Function`. So **each bot gets its own QuickJS (WASM) context inside `RoomDO`**:

- **Memory limit** per context, e.g. 8 MB.
- **Per-tick budget in operations, not milliseconds.** QuickJS's interrupt handler fires every N bytecode operations; we count those calls. The limit is the same on a laptop and on the server, and it's deterministic.
  - Over budget: the previous action is reused this tick and the bot gets a strike.
  - 3 strikes in a row or an obvious infinite loop: death by `timeout`.
- **Determinism.** `Math.random` is replaced with a seeded PRNG (different per life). `Date`, `fetch`, timers and `import` are unavailable.
- **Context lifetime:** one context per life, so memory persists between ticks and resets between lives.
- **The same sandbox package** runs in `RoomDO`, in the CLI (`sim`, `test`) and in deploy checks. A bot that passes tests locally behaves the same on the server.

**Hypothesis to verify in v0:** QuickJS can handle 20 bots × 10 ticks/s in one DO. If not:
- smaller rooms;
- lower tick rate;
- move to Dynamic Worker Loader / Workers for Platforms (V8 isolates, but every tick becomes an RPC call).

**DO limits.** CPU per invocation is capped (30 s by default, can be raised). Simulation runs in batches of ticks inside the alarm handler; room state lives in memory and in the DO's SQLite storage between batches.

---

## 6. Deploy and checks

1. `zerosnake deploy` bundles `src/` locally (esbuild) into a single ESM file and uploads **the bundle plus a source archive**. Limits: ≤ 50 files, sources ≤ 1 MB, bundle ≤ 256 KB.
2. The API stores both in R2, creates a version with status `validating` and enqueues a job.
3. The consumer runs the checks:
   - the bundle loads in QuickJS and exports `tick`;
   - 5 fixed seeds × 1000 ticks against house bots: no exceptions, no timeouts, within budget;
   - **qualification:** mean score at least that of the `easy` house bot.
4. Result: status `ready`, the bot's previous version is archived and the new one joins the queue. Or `rejected` with a report the CLI prints in plain language.

Version sources are public on the profile (the project is fully open source).

---

## 7. Replays, traces, MCP

- **Room replay** is written in ~2-minute chunks: seed, a snapshot at chunk start and every bot's actions per tick, compressed. Target: tens of KB per chunk. Stored in R2.
- **Life trace** stores per tick: the action, operations used and `log()` output (byte limit per tick). The last 100 ticks before death are kept in full, the rest is downsampled. Kept for 7 days. Also a summary of what the bot saw (head, wall distance, nearest snake and food). At most 512 KB per life; format in `apps/web/src/shared/trace.ts`. **Only the bot's owner can read a trace** (CLI `zerosnake logs --deaths`, the replay page when signed in): it holds the author's own logs, which may say more than the published source.
- **Replay viewer** replays the engine locally from seed + actions and shows: timeline, jump to death, the selected snake's vision radius, its logs.
- **MCP** runs on Workers via the Agents SDK `McpAgent`, auth via Better Auth. Tools:
  - `list_bots`, `list_versions`;
  - `list_lives(version, filter: deaths|best|worst)`;
  - `get_death_context(life)`: what the snake saw in the last N ticks, what the bot returned, its logs;
  - `compare_versions(a, b)`;
  - `get_leaderboard`.

---

## 8. Architecture

```
apps/web        TanStack Start on Workers: site, Better Auth (GitHub OAuth + device flow for the CLI), deploy API
apps/arena      Worker: MatchmakerDO, RoomDO, Queue consumer (checks), spectator WebSockets, MCP
packages/engine    deterministic simulation (pure TS, no dependencies)
packages/sandbox   QuickJS bot runner: op budget, limits, PRNG
packages/sdk       state/action types, defineBot()
packages/renderer  three.js renderer from the original ZeroSnake (PlayerRenderer, FoodRenderer, BackgroundRenderer, SVG skins)
packages/cli       npx zerosnake: init, sim, test, login, deploy, logs
bots/house         house bots: easy / medium / hard / chaos
template/          bot template: src/bot.ts, CLAUDE.md, .claude/skills, tests
```

**Storage:**
- **D1:** Better Auth tables, `bots`, `versions`, `lives` (score, cause of death, replay and trace keys), `ratings`.
- **R2:** bundles, sources, replays, traces.
- **DO SQLite:** matchmaker queue, room state.

**Bot template:**

```ts
import { defineBot } from "@zerosnake/sdk";

export default defineBot({
  init(info) {
    // start of a life: world size, vision radius, budget
    return { mode: "farm" }; // memory between ticks
  },
  tick(state, mem, log) {
    // ...strategy
    return { turn: 0.3, boost: false };
  },
});
```

The template's `CLAUDE.md` describes the rules, API, limits and common causes of death. Skills: `new-strategy`, `debug-death` (via MCP), `compare-with-previous`.

---

## 9. Cost (rough estimate, verify on the prototype)

Cloudflare prices below are from memory and need checking:
- DO: $12.50 per 1M GB-s beyond the included 400k;
- Workers Paid: $5/month.

Estimate step by step:
1. One tick with 10 bots at ~1 ms per bot is ~12 ms of CPU.
2. So 3000 ticks of such a room take ~36 s, roughly 3–4 s per life.
3. At 128 MB that's ~0.45 GB-s per life, i.e. **~$6 per million lives**.

R2 for replays is pennies. Takeaway: compute is cheap. Quotas exist mainly for fairness and abuse protection, not to save money. The real bottleneck is the throughput of a single DO (one core), which scales with the number of rooms.

---

## 10. Milestones

- **v0 — Core (local).** `engine`, `sandbox`, `sdk`, house bots, `cli sim/test`, viewer on the ZeroSnake renderer, template. QuickJS benchmark.
- **v1 — Arena MVP.** Site, auth, `login`/`deploy`, checks, matchmaker and rooms in accelerated mode, leaderboard, profiles, replays.
- **v2 — Insight and spectacle.** Traces, MCP, live showcase, version comparison, bot skins.
- **v3 — Growth.** Seasons, tournaments, paid quotas, a second mode (agar.io) on the same infrastructure.

---

## 11. Open questions

1. Register zerosnake.io?
2. A paid tier with higher quotas, or everything free for now?
3. Custom bot skins (color, pattern) in v1 or later?
4. npm package name `zerosnake` (check availability) or scope `@zerosnake/cli`?
5. One-click fork of someone else's bot from their profile, since everything is open? Speeds up growth but fills the leaderboard with clones.
6. Co-authorship (teams) on a single bot?
