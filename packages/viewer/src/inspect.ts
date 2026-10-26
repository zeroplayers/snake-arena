import type { LifeInfo, MatchSource, SnakeTick, TickSnapshot } from "./types.ts";

export type LifeState =
  | { readonly kind: "unknown" }
  | { readonly kind: "unborn"; readonly life: LifeInfo }
  | { readonly kind: "alive"; readonly life: LifeInfo; readonly snake: SnakeTick }
  | { readonly kind: "dead"; readonly life: LifeInfo };

/** Where a life stands on `tick`. */
export function lifeAt(
  source: MatchSource,
  id: string,
  snapshot: TickSnapshot | undefined,
): LifeState {
  const life = source.life(id);
  if (!life) return { kind: "unknown" };
  const tick = snapshot?.tick ?? source.lastTick;
  if (tick < life.bornTick) return { kind: "unborn", life };
  if (life.death && tick >= life.death.tick) return { kind: "dead", life };
  const snake = snapshot?.snakes.find((s) => s.id === id);
  return snake ? { kind: "alive", life, snake } : { kind: "unknown" };
}

export interface LogEntry {
  readonly tick: number;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/** The life's `log()` output on the `maxTicks` ticks up to `tick` that logged anything. */
export function recentLogs(
  source: MatchSource,
  id: string,
  tick: number,
  maxTicks = 40,
): LogEntry[] {
  const life = source.life(id);
  if (!life) return [];
  const out: LogEntry[] = [];
  const from = Math.max(source.firstTick, life.bornTick);
  for (let t = Math.min(tick, source.lastTick); t >= from && out.length < maxTicks; t--) {
    const trace = source.trace
      ? source.trace(id, t)
      : source.snapshot(t)?.snakes.find((s) => s.id === id);
    if (trace?.logs && trace.logs.length > 0) {
      out.push({ tick: t, lines: trace.logs, truncated: trace.logTruncated === true });
    }
  }
  return out.reverse();
}

/** Living snakes on a tick, best score first. */
export function ranking(snapshot: TickSnapshot | undefined): SnakeTick[] {
  return snapshot ? [...snapshot.snakes].sort((a, b) => b.score - a.score) : [];
}

/** Lives that ended at or before `tick`, most recent first. */
export function recentDeaths(source: MatchSource, tick: number, limit: number): LifeInfo[] {
  const out: LifeInfo[] = [];
  const lives = source.lives();
  for (let i = lives.length - 1; i >= 0; i--) {
    const life = lives[i] as LifeInfo;
    if (life.death && life.death.tick <= tick) out.push(life);
  }
  out.sort((a, b) => (b.death?.tick ?? 0) - (a.death?.tick ?? 0));
  return out.slice(0, limit);
}

/** The living snake whose body passes closest to `at`, within `slack` of its edge. */
export function pickSnake(
  snapshot: TickSnapshot | undefined,
  at: { x: number; y: number },
  slack: number,
): string | undefined {
  if (!snapshot) return undefined;
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of snapshot.frame.snakes) {
    const r = (s.radius ?? 1) + slack;
    for (const p of s.segments) {
      const d = Math.hypot(p.x - at.x, p.y - at.y) - r;
      if (d < 0 && d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
  }
  return best;
}
