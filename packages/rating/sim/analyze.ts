/**
 * What the simulated lives say about the rating (points per minute alive) and room composition:
 * how far a kind's rate moves with the room, whether `normalizeScore` pulls it back, and how a
 * rating behaves at the ranking threshold (an hour alive) and over a full 200-life window.
 */
import type { HouseBotName } from "@zerosnake/house-bots";
import { createRatingConfig, minRankedTicks } from "../src/config.ts";
import { type NormalizationConfig, normalizeScore } from "../src/normalize.ts";
import { createRatingState, type RatedLife, rate } from "../src/rating.ts";
import { ratioSummary, summarize, tQuantile } from "../src/stats.ts";
import type { Composition, Life } from "./room.ts";

export type Cells = Map<string, Map<HouseBotName, RatedLife[]>>;

const CONFIG = createRatingConfig();
const MINUTE = CONFIG.ticksPerMinute;
const HOUR_TICKS = minRankedTicks(CONFIG);

export function cellsOf(byComposition: Map<string, Life[]>): Cells {
  const cells: Cells = new Map();
  for (const [name, lives] of byComposition) {
    const cell = new Map<HouseBotName, RatedLife[]>();
    for (const l of lives) {
      const list = cell.get(l.kind) ?? [];
      list.push({ score: l.score, ticks: Math.max(1, l.ticks) });
      cell.set(l.kind, list);
    }
    cells.set(name, cell);
  }
  return cells;
}

/** Points per minute alive over `lives`: Σ score / Σ minutes. */
export function perMinute(lives: readonly RatedLife[]): number {
  let score = 0;
  let ticks = 0;
  for (const l of lives) {
    score += l.score;
    ticks += l.ticks;
  }
  return ticks > 0 ? (score * MINUTE) / ticks : 0;
}

/**
 * A kind's long-run rating when each life lands in a uniformly random room: E[score] / E[minutes]
 * with both expectations averaged over the rooms (renewal–reward), so rooms where it lives longer
 * weigh more, as they do in a rating.
 */
export function kindRatings(cells: Cells): Map<HouseBotName, number> {
  const acc = new Map<HouseBotName, { score: number; ticks: number }>();
  for (const cell of cells.values()) {
    for (const [kind, lives] of cell) {
      const a = acc.get(kind) ?? { score: 0, ticks: 0 };
      a.score += mean(lives.map((l) => l.score));
      a.ticks += mean(lives.map((l) => l.ticks));
      acc.set(kind, a);
    }
  }
  return new Map([...acc].map(([k, a]) => [k, (a.score * MINUTE) / a.ticks]));
}

/** Mean rating of the other snakes a `kind` shares the room with. */
export function strengthFor(
  composition: Composition,
  kind: HouseBotName,
  ratings: Map<HouseBotName, number>,
): number {
  let total = 0;
  let count = 0;
  for (const [k, n] of Object.entries(composition) as [HouseBotName, number][]) {
    const others = k === kind ? n - 1 : n;
    total += others * (ratings.get(k) ?? 0);
    count += others;
  }
  return total / count;
}

/** OLS slope of log(rate) on log(strength) with a separate intercept per kind. */
export function elasticity(points: { kind: string; x: number; y: number }[]): number {
  const byKind = new Map<string, typeof points>();
  for (const p of points) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
  let sxy = 0;
  let sxx = 0;
  for (const ps of byKind.values()) {
    const mx = mean(ps.map((p) => Math.log(p.x)));
    const my = mean(ps.map((p) => Math.log(p.y)));
    for (const p of ps) {
      sxy += (Math.log(p.x) - mx) * (Math.log(p.y) - my);
      sxx += (Math.log(p.x) - mx) ** 2;
    }
  }
  return sxy / sxx;
}

export interface Report {
  lines: string[];
  recommendedAlpha: number;
}

export function analyze(
  compositions: Record<string, Composition>,
  cells: Cells,
  kinds: readonly HouseBotName[],
  rng: () => number,
): Report {
  const lines: string[] = [];
  const out = (s = "") => lines.push(s);
  const ratings = kindRatings(cells);
  const names = Object.keys(compositions);
  const strength = (c: string, k: HouseBotName) => strengthFor(compositions[c] ?? {}, k, ratings);
  const reference = mean(kinds.map((k) => ratings.get(k) ?? 0));
  const livesOf = (c: string, k: HouseBotName) => cells.get(c)?.get(k) ?? [];

  out("### Points per minute by room composition (± 95% CI; lives, median life)");
  out();
  out(`| room | ${kinds.map((k) => `${k}: strength seen | ${k}: pts/min`).join(" | ")} |`);
  out(`|---|${kinds.map(() => "--:|--:").join("|")}|`);
  for (const c of names) {
    const cols = kinds.map((k) => {
      const lives = livesOf(c, k);
      const s = ratioSummary(
        lives.map((l) => l.score * MINUTE),
        lives.map((l) => l.ticks),
      );
      const median = [...lives.map((l) => l.ticks)].sort((a, b) => a - b)[lives.length >> 1] ?? 0;
      return `${fmt(strength(c, k))} | ${fmt(s.ratio)} ± ${fmt(CONFIG.z * s.se)} (${s.n}, ${fmt(median / 10)} s)`;
    });
    out(`| ${c} ${label(compositions[c] ?? {})} | ${cols.join(" | ")} |`);
  }
  out();
  out(
    `Long-run ratings (random rooms, pts/min): ${[...ratings].map(([k, r]) => `${k} ${fmt(r)}`).join(", ")}`,
  );
  out();

  const points = kinds.flatMap((k) =>
    names.map((c) => ({ kind: k, x: strength(c, k), y: perMinute(livesOf(c, k)) })),
  );
  const pooled = -elasticity(points);
  out("### Skew and normalization");
  out();
  out(
    "Elasticity of the rate to room strength, fitted per kind and pooled (alpha = −slope; " +
      "leave-one-out fits on the other kinds only):",
  );
  out();
  out("| kind | own alpha | leave-one-out alpha | raw max/min | normalized max/min (LOO) |");
  out("|---|--:|--:|--:|--:|");
  for (const k of kinds) {
    const own = -elasticity(points.filter((p) => p.kind === k));
    const loo = -elasticity(points.filter((p) => p.kind !== k));
    const raw = names.map((c) => perMinute(livesOf(c, k)));
    const norm = names.map((c) =>
      perMinute(livesOf(c, k).map((l) => normalize(l, strength(c, k), loo, reference))),
    );
    out(
      `| ${k} | ${fmt(own, 2)} | ${fmt(loo, 2)} | ${fmt(spread(raw), 2)} | ${fmt(spread(norm), 2)} |`,
    );
  }
  out();
  out(`Pooled alpha: ${fmt(pooled, 2)} (reference strength ${fmt(reference)}).`);
  out();

  // Ratings a version would get from its lives, by how rooms were assigned: a full window of
  // `CONFIG.window` lives, or the first lives that add up to an hour alive (the threshold).
  const draws = 2000;
  const pickLife = (k: HouseBotName, c: string, alpha: number): RatedLife => {
    const lives = livesOf(c, k);
    const l = lives[Math.floor(rng() * lives.length)] ?? { score: 0, ticks: 1 };
    return normalize(l, strength(c, k), alpha, reference);
  };
  const windowOf = (k: HouseBotName, pick: () => string, alpha: number) =>
    Array.from({ length: CONFIG.window }, () => pickLife(k, pick(), alpha));
  const hourOf = (k: HouseBotName, pick: () => string) => {
    const lives: RatedLife[] = [];
    let ticks = 0;
    while (ticks < HOUR_TICKS || lives.length < 2) {
      const l = pickLife(k, pick(), 0);
      lives.push(l);
      ticks += l.ticks;
    }
    return lives;
  };
  const uniform = () => names[Math.floor(rng() * names.length)] ?? "";
  out(`### ${CONFIG.window}-life ratings (${draws} resampled windows per row)`);
  out();
  out(
    "Random rooms: every life in a uniformly random room. Stuck: every life in the room where " +
      "the kind's rate is lowest / highest (raw), the worst systematic skew this lineup can produce.",
  );
  out();
  out("| kind | alpha | random: mean ± sd | stuck low | stuck high | stuck gap / random sd |");
  out("|---|--:|--:|--:|--:|--:|");
  for (const alpha of [0, pooled]) {
    const longRun = new Map<HouseBotName, number[]>();
    for (const k of kinds) {
      const rates = names.map((c) => perMinute(livesOf(c, k)));
      const lo = names[rates.indexOf(Math.min(...rates))] ?? "";
      const hi = names[rates.indexOf(Math.max(...rates))] ?? "";
      const random = Array.from({ length: draws }, () => perMinute(windowOf(k, uniform, alpha)));
      longRun.set(k, random);
      const r = summarize(random);
      const low = mean(Array.from({ length: 200 }, () => perMinute(windowOf(k, () => lo, alpha))));
      const high = mean(Array.from({ length: 200 }, () => perMinute(windowOf(k, () => hi, alpha))));
      out(
        `| ${k} | ${fmt(alpha, 2)} | ${fmt(r.mean)} ± ${fmt(r.sd)} | ${fmt(low)} (${lo}) | ` +
          `${fmt(high)} (${hi}) | ${fmt((high - low) / r.sd, 1)} |`,
      );
    }
    // How often a fresh set of windows ranks the kinds as their long-run rates do.
    const truth = [...kinds].sort(
      (a, b) => mean(longRun.get(b) ?? []) - mean(longRun.get(a) ?? []),
    );
    let hits = 0;
    for (let i = 0; i < draws; i++) {
      const got = [...kinds].sort(
        (a, b) => (longRun.get(b)?.[i] ?? 0) - (longRun.get(a)?.[i] ?? 0),
      );
      if (got.join() === truth.join()) hits++;
    }
    out(
      `| order ${truth.join(" > ")} | ${fmt(alpha, 2)} | ${fmt((100 * hits) / draws, 1)}% of windows | | | |`,
    );
  }
  out();

  out("### Confidence interval coverage (delta method, Student's t, raw scores)");
  out();
  out(
    "Share of ratings whose `mean ± ci` (as `rate()` computes it) contains the kind's long-run " +
      "rate. First hour: the first lives that add up to an hour alive, where a version gets " +
      "ranked; the column also gives the median number of lives that takes.",
  );
  out();
  out(
    "| kind | first hour, random rooms | 200 lives, random rooms | first hour, balanced room | 200 lives, balanced room |",
  );
  out("|---|--:|--:|--:|--:|");
  for (const k of kinds) {
    const cover = (sample: () => RatedLife[], truth: number) => {
      let hit = 0;
      const ns: number[] = [];
      for (let i = 0; i < draws; i++) {
        const lives = sample();
        ns.push(lives.length);
        const r = rate(createRatingState(lives, lives.length, undefined, CONFIG), CONFIG);
        if (r && Math.abs(r.mean - truth) <= r.ci) hit++;
      }
      const n = ns.sort((a, b) => a - b)[ns.length >> 1] ?? 0;
      return `${fmt((100 * hit) / draws, 1)}% (${n})`;
    };
    const one = names.includes("balanced") ? "balanced" : (names[0] ?? "");
    const oneTruth = perMinute(livesOf(one, k));
    const all = ratings.get(k) ?? 0;
    out(
      `| ${k} | ${cover(() => hourOf(k, uniform), all)} | ${cover(() => windowOf(k, uniform, 0), all)} | ` +
        `${cover(() => hourOf(k, () => one), oneTruth)} | ${cover(() => windowOf(k, () => one, 0), oneTruth)} |`,
    );
  }
  out();
  out(
    `(t quantile at 30 and 200 lives: ${fmt(tQuantile(CONFIG.z, 29), 3)}, ${fmt(tQuantile(CONFIG.z, 199), 3)}.)`,
  );
  return { lines, recommendedAlpha: pooled };
}

function normalize(life: RatedLife, strength: number, alpha: number, reference: number): RatedLife {
  const config: NormalizationConfig = { enabled: true, reference, alpha, maxFactor: 2 };
  return { score: normalizeScore(life.score, strength, config), ticks: life.ticks };
}

function mean(xs: readonly number[]): number {
  return summarize(xs).mean;
}

function spread(xs: readonly number[]): number {
  return Math.max(...xs) / Math.min(...xs);
}

function label(c: Composition): string {
  return `(${Object.entries(c)
    .map(([k, n]) => `${k[0]?.toUpperCase()}${n}`)
    .join(" ")})`;
}

function fmt(x: number, digits = 0): string {
  return x.toFixed(digits);
}
