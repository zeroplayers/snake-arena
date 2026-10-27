import { describe, expect, it } from "vitest";
import {
  type BotInfo,
  type BotState,
  CENTER,
  createTickLog,
  defineBot,
  LOG_LIMIT_BYTES,
  nearestDanger,
  nearestFood,
  steerAway,
  steerToward,
} from "./index.ts";

// An example bot written only against the public API, the way a bot author would.
const bot = defineBot({
  init(info) {
    return { mode: "farm" as "farm" | "flee", seed: info.seed, fled: 0 };
  },
  tick(state, mem, log) {
    const { self } = state;
    if (state.wallDistance < self.radius * 10) {
      return { turn: steerToward(self, CENTER) };
    }
    const danger = nearestDanger(state);
    if (danger && danger.gap < self.radius * 4) {
      mem.mode = "flee";
      mem.fled++;
      log("fleeing", danger.snake.id, danger.gap.toFixed(1));
      return { turn: steerAway(self, danger.point), boost: true };
    }
    mem.mode = "farm";
    const food = nearestFood(state);
    return { turn: food ? steerToward(self, food) : 0 };
  },
});

// Bots that should not compile.
defineBot({
  // @ts-expect-error turn is required
  tick: () => ({ boost: true }),
});
defineBot({
  init: () => ({ n: 0 }),
  tick(_state, mem) {
    // @ts-expect-error memory type is inferred from init
    mem.missing = 1;
    return { turn: 0 };
  },
});
defineBot({
  tick(state) {
    // @ts-expect-error `head` may be null for other snakes
    const x: number = state.snakes[0]?.head.x ?? 0;
    return { turn: x };
  },
});

const info: BotInfo = {
  snakeId: "me",
  worldHalfSize: 1000,
  visionRadius: 300,
  tickRate: 10,
  maxLifeTicks: 6000,
  opBudget: 100_000,
  logLimitBytes: LOG_LIMIT_BYTES,
  seed: 42,
};

function state(overrides: Partial<BotState> = {}): BotState {
  return {
    tick: 100,
    lifeTick: 0,
    self: {
      id: "me",
      head: { x: 0, y: 0 },
      angle: 0,
      length: 10,
      speed: 2,
      radius: 2,
      turnRate: 0.1,
      boosting: false,
      segments: [{ x: 0, y: 0 }],
    },
    snakes: [],
    food: [],
    wallDistance: 1000,
    ...overrides,
  };
}

describe("example bot", () => {
  it("survives a JSON round trip of its state", () => {
    const s = state({ food: [{ x: 5, y: 5, value: 1 }] });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("runs init then tick with memory and log", () => {
    const mem = bot.init?.(info);
    expect(mem).toEqual({ mode: "farm", seed: 42, fled: 0 });
    if (!mem) throw new Error("init missing");
    const t = createTickLog();

    // Heading east with y up, food at (1, 50) is up-left: turn left.
    expect(bot.tick(state({ food: [{ x: 1, y: 50, value: 1 }] }), mem, t.log).turn).toBe(-1);

    // A snake right ahead: flee, boost and log.
    const threat = {
      id: "enemy",
      author: "bob",
      length: 30,
      radius: 2,
      head: { x: 8, y: -1 },
      angle: Math.PI,
      boosting: false,
      segments: [{ x: 8, y: -1 }],
    };
    const action = bot.tick(state({ snakes: [threat] }), mem, t.log);
    expect(action.boost).toBe(true);
    expect(action.turn).toBe(-1); // threat slightly to the right (y = -1 is below), so turn left
    expect(mem).toMatchObject({ mode: "flee", fled: 1 });
    expect(t.flush().lines).toEqual(["fleeing enemy 4.1"]);

    // Near the wall: head for the centre.
    const nearWall = state({ wallDistance: 5 });
    nearWall.self.head = { x: 995, y: 0 };
    expect(Math.abs(bot.tick(nearWall, mem, t.log).turn)).toBe(1);
  });
});
