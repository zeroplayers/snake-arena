/** Hand-built states for the house bot tests. Not exported from the package. */
import {
  type Bot,
  type BotAction,
  type BotInfo,
  type BotState,
  createTickLog,
  LOG_LIMIT_BYTES,
  normalizeAngle,
  type SelfState,
  type SnakeView,
  type Vec,
} from "@zerosnake/sdk";

export const WORLD_RADIUS = 100;

export function info(seed = 1): BotInfo {
  return {
    snakeId: "me",
    worldRadius: WORLD_RADIUS,
    visionRadius: 30,
    tickRate: 10,
    maxLifeTicks: 6000,
    opBudget: 100_000,
    logLimitBytes: LOG_LIMIT_BYTES,
    seed,
  };
}

/** Our snake, by default at the centre heading east (angle 0) at engine speed and turn rate. */
export function self(o: Partial<SelfState> = {}): SelfState {
  const head = o.head ?? { x: 0, y: 0 };
  const angle = o.angle ?? 0;
  return {
    id: "me",
    length: 10,
    speed: 1.5,
    radius: 0.5,
    turnRate: 0.25,
    boosting: false,
    segments: [0, 1, 2, 3, 4, 5].map((i) => ({
      x: head.x - Math.cos(angle) * i,
      y: head.y - Math.sin(angle) * i,
    })),
    ...o,
    head,
    angle,
  };
}

/** Another snake. Its head is `segments[0]` unless `head: null` says it is out of sight. */
export function snake(segments: Vec[], o: Partial<SnakeView> = {}): SnakeView {
  return {
    id: "other",
    author: "someone",
    length: 10,
    radius: 0.5,
    head: segments[0] ?? null,
    angle: 0,
    boosting: false,
    segments,
    ...o,
  };
}

/** A straight body from `from` along `angle`, `count` points 1 apart. */
export function line(from: Vec, angle: number, count: number): Vec[] {
  return Array.from({ length: count }, (_, i) => ({
    x: from.x + Math.cos(angle) * i,
    y: from.y + Math.sin(angle) * i,
  }));
}

export function state(o: Partial<BotState> = {}): BotState {
  const me = o.self ?? self();
  return {
    tick: 0,
    lifeTick: 0,
    snakes: [],
    food: [],
    wallDistance: WORLD_RADIUS - Math.hypot(me.head.x, me.head.y),
    ...o,
    self: me,
  };
}

/** Runs `init` (if any) and one `tick`. */
export function act<M extends object>(bot: Bot<M>, s: BotState, seed = 1): BotAction {
  const mem = bot.init?.(info(seed)) ?? ({} as M);
  return bot.tick(s, mem, createTickLog().log);
}

/**
 * Drives a bot through a tiny kinematic world: a disc of `worldRadius` with static bodies
 * (radius 0.5) at `obstacles`, the engine's turning rule, no food. Returns the tick on which the
 * head touched a body or the wall, or `null` if it survived.
 */
export function drive<M extends object>(
  bot: Bot<M>,
  o: { obstacles: Vec[]; worldRadius: number; ticks: number; seed?: number; vision?: number },
): number | null {
  const mem = bot.init?.(info(o.seed ?? 1)) ?? ({} as M);
  const { log } = createTickLog();
  const vision2 = (o.vision ?? 30) ** 2;
  let me = self();
  for (let t = 0; t < o.ticks; t++) {
    const h = me.head;
    const seen = o.obstacles.filter((p) => (p.x - h.x) ** 2 + (p.y - h.y) ** 2 <= vision2);
    const s = state({
      tick: t,
      lifeTick: t,
      self: me,
      snakes: seen.length ? [snake(seen, { head: null, angle: null })] : [],
      wallDistance: o.worldRadius - Math.hypot(h.x, h.y),
    });
    const action = bot.tick(s, mem, log);
    const turn = Math.max(-1, Math.min(1, Number(action.turn) || 0));
    const angle = normalizeAngle(me.angle - turn * me.turnRate);
    const head = { x: h.x + Math.cos(angle) * me.speed, y: h.y + Math.sin(angle) * me.speed };
    me = self({ head, angle });
    if (Math.hypot(head.x, head.y) > o.worldRadius) return t;
    for (const p of o.obstacles) if (Math.hypot(p.x - head.x, p.y - head.y) < 1) return t;
  }
  return null;
}
