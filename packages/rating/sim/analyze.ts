/**
 * What the simulated lives say about room composition: how far a kind's mean score moves with
 * the room, whether `normalizeScore` pulls it back, and how a 200-life rating behaves.
 */
import type { HouseBotName } from "@zerosnake/house-bots";
import { createRatingConfig } from "../src/config.ts";
import { type NormalizationConfig, normalizeScore } from "../src/normalize.ts";
import { summarize } from "../src/stats.ts";
import type { Composition, Life } from "./room.ts";

export type Cells = Map<string, Map<HouseBotName, number[]>>;

const CONFIG = createRatingConfig();

export function cellsOf(byComposition: Map<string, Life[]>): Cells {
  const cells: Cells = new Map();
  for (const [name, lives] of byComposition) {
    const cell = new Map<HouseBotName, number[]>();
    for (const l of lives) {
      const scores = cell.get(l.kind) ?? [];
      scores.push(l.score);
      cell.set(l.kind, scores);
    }
    cells.set(name, cell);
  }
  return cells;
}

/** A kind's long-run rating with uniformly random room assignment: the mean of its cell means. */
export function kindRatings(cells: Cells): Map<HouseBotName, number> {
  const acc = new Map<HouseBotName, number[]>();
  for (const cell of cells.values()) {
    for (const [kind, scores] of cell) acc.set(kind, [...(acc.get(kind) ?? []), mean(scores)]);
  }
  return new Map([...acc].map(([k, means]) => [k, mean(means)]));
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

/** OLS slope of log(mean score) on log(strength) with a separate intercept per kind. */
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

  out("### Mean life score by room composition (± 95% CI, lives)");
  out();
  out(`| room | ${kinds.map((k) => `${k}: strength seen | ${k}: score`).join(" | ")} |`);
  out(`|---|${kinds.map(() => "--:|--:").join("|")}|`);
  for (const c of names) {
    const cols = kinds.map((k) => {
      const s = summarize(cells.get(c)?.get(k) ?? []);
      const ci = (CONFIG.z * s.sd) / Math.sqrt(s.n);
      return `${fmt(strength(c, k))} | ${fmt(s.mean)} ± ${fmt(ci)} (${s.n})`;
    });
    out(`| ${c} ${label(compositions[c] ?? {})} | ${cols.join(" | ")} |`);
  }
  out();
  out(
    `Long-run ratings (mean over rooms): ${[...ratings].map(([k, r]) => `${k} ${fmt(r)}`).join(", ")}`,
  );
  out();

  const points = kinds.flatMap((k) =>
    names.map((c) => ({ kind: k, x: strength(c, k), y: mean(cells.get(c)?.get(k) ?? []) })),
  );
  const pooled = -elasticity(points);
  out("### Skew and normalization");
  out();
  out(
    "Elasticity of score to room strength, fitted per kind and pooled (alpha = −slope; leave-one-out " +
      "fits on the other kinds only):",
  );
  out();
  out("| kind | own alpha | leave-one-out alpha | raw max/min | normalized max/min (LOO) |");
  out("|---|--:|--:|--:|--:|");
  for (const k of kinds) {
    const own = -elasticity(points.filter((p) => p.kind === k));
    const loo = -elasticity(points.filter((p) => p.kind !== k));
    const raw = names.map((c) => mean(cells.get(c)?.get(k) ?? []));
    const norm = names.map((c) =>
      mean((cells.get(c)?.get(k) ?? []).map((s) => normalize(s, strength(c, k), loo, reference))),
    );
    out(
      `| ${k} | ${fmt(own, 2)} | ${fmt(loo, 2)} | ${fmt(spread(raw), 2)} | ${fmt(spread(norm), 2)} |`,
    );
  }
  out();
  out(`Pooled alpha: ${fmt(pooled, 2)} (reference strength ${fmt(reference)}).`);
  out();

  // Ratings a version would get from a 200-life window, by how rooms were assigned.
  const draws = 2000;
  const windowOf = (k: HouseBotName, pick: () => string, alpha: number) => {
    const xs: number[] = [];
    for (let i = 0; i < CONFIG.window; i++) {
      const c = pick();
      const scores = cells.get(c)?.get(k) ?? [];
      const s = scores[Math.floor(rng() * scores.length)] ?? 0;
      xs.push(normalize(s, strength(c, k), alpha, reference));
    }
    return xs;
  };
  const uniform = () => names[Math.floor(rng() * names.length)] ?? "";
  out(`### ${CONFIG.window}-life ratings (${draws} resampled windows per row)`);
  out();
  out(
    "Random rooms: every life in a uniformly random room. Stuck: every life in the room where " +
      "the kind scores lowest / highest (raw), the worst systematic skew this lineup can produce.",
  );
  out();
  out("| kind | alpha | random: mean ± sd | stuck low | stuck high | stuck gap / random sd |");
  out("|---|--:|--:|--:|--:|--:|");
  const orderHits = new Map<number, number>();
  for (const alpha of [0, pooled]) {
    const longRun = new Map<HouseBotName, number[]>();
    for (const k of kinds) {
      const means = names.map((c) => mean(cells.get(c)?.get(k) ?? []));
      const lo = names[means.indexOf(Math.min(...means))] ?? "";
      const hi = names[means.indexOf(Math.max(...means))] ?? "";
      const random = Array.from({ length: draws }, () => mean(windowOf(k, uniform, alpha)));
      longRun.set(k, random);
      const r = summarize(random);
      const low = mean(Array.from({ length: 200 }, () => mean(windowOf(k, () => lo, alpha))));
      const high = mean(Array.from({ length: 200 }, () => mean(windowOf(k, () => hi, alpha))));
      out(
        `| ${k} | ${fmt(alpha, 2)} | ${fmt(r.mean)} ± ${fmt(r.sd)} | ${fmt(low)} (${lo}) | ` +
          `${fmt(high)} (${hi}) | ${fmt((high - low) / r.sd, 1)} |`,
      );
    }
    // How often a fresh set of windows ranks the kinds as their long-run means do.
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
    orderHits.set(alpha, hits / draws);
    out(
      `| order ${truth.join(" > ")} | ${fmt(alpha, 2)} | ${fmt((100 * hits) / draws, 1)}% of windows | | | |`,
    );
  }
  out();

  out("### Confidence interval coverage (normal approximation, raw scores)");
  out();
  out("Share of windows whose `mean ± 1.96·s/√n` contains the kind's long-run rating.");
  out();
  out(
    "| kind | n = 30, random rooms | n = 200, random rooms | n = 30, balanced room | n = 200, balanced room |",
  );
  out("|---|--:|--:|--:|--:|");
  for (const k of kinds) {
    const cover = (n: number, pick: () => string, truth: number) => {
      let hit = 0;
      for (let i = 0; i < draws; i++) {
        const xs = windowOf(k, pick, 0).slice(0, n);
        const s = summarize(xs);
        if (Math.abs(s.mean - truth) <= (CONFIG.z * s.sd) / Math.sqrt(n)) hit++;
      }
      return `${fmt((100 * hit) / draws, 1)}%`;
    };
    const one = names.includes("balanced") ? "balanced" : (names[0] ?? "");
    const oneTruth = mean(cells.get(one)?.get(k) ?? []);
    out(
      `| ${k} | ${cover(30, uniform, ratings.get(k) ?? 0)} | ${cover(200, uniform, ratings.get(k) ?? 0)} | ` +
        `${cover(30, () => one, oneTruth)} | ${cover(200, () => one, oneTruth)} |`,
    );
  }
  return { lines, recommendedAlpha: pooled };
}

function normalize(score: number, strength: number, alpha: number, reference: number): number {
  const config: NormalizationConfig = { enabled: true, reference, alpha, maxFactor: 2 };
  return normalizeScore(score, strength, config);
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
