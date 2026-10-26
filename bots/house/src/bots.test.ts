import type { Bot } from "@zerosnake/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chaos, easy, hard, houseBots, medium, RANKED } from "./index.ts";
import { act, drive, info, line, self, snake, state, WORLD_RADIUS } from "./testing.ts";

// Conventions (see @zerosnake/sdk): y is up, angle 0 is east, `turn` < 0 is left.
const SMART: Record<string, Bot<object>> = { medium, hard, chaos };
const FARMERS: Record<string, Bot<object>> = { easy, medium, hard };

/** A body across our road 6 units ahead (x = 6, y from -6 to 6). */
const wallAhead = () => snake(line({ x: 6, y: -6 }, Math.PI / 2, 13), { head: null, angle: null });

/**
 * Bodies scattered on a grid, kept off the wall: a pocket between a body and the wall narrower
 * than the turning circle (12 across) is a trap no snake can leave.
 */
function clutter() {
  const obstacles = [];
  for (let x = -20; x <= 20; x += 20) {
    for (let y = -20; y <= 20; y += 20) {
      if (x !== 0 || y !== 0) obstacles.push(...line({ x, y }, (x + 2 * y) / 9, 8));
    }
  }
  return obstacles;
}

describe("houseBots", () => {
  it("exports every bot by name", () => {
    expect(Object.keys(houseBots).sort()).toEqual(["chaos", "easy", "hard", "medium"]);
    expect(houseBots.easy).toBe(easy);
    expect(RANKED).toEqual(["easy", "medium", "hard"]);
    for (const bot of Object.values(houseBots)) expect(typeof bot.tick).toBe("function");
  });

  it("returns a valid action on an empty view", () => {
    for (const bot of Object.values(houseBots)) {
      const action = act(bot, state());
      expect(Math.abs(action.turn)).toBeLessThanOrEqual(1);
      expect(action.boost ?? false).toBe(false);
    }
  });
});

describe.each(Object.entries(FARMERS))("%s: food", (_, bot) => {
  it("turns toward food on the left and on the right", () => {
    expect(act(bot, state({ food: [{ x: 8, y: 6, value: 1 }] })).turn).toBeLessThan(0);
    expect(act(bot, state({ food: [{ x: 8, y: -6, value: 1 }] })).turn).toBeGreaterThan(0);
  });

  it("goes straight for food dead ahead", () => {
    expect(act(bot, state({ food: [{ x: 10, y: 0, value: 1 }] })).turn).toBeCloseTo(0);
  });

  it("skips food inside its turning circle instead of orbiting it", () => {
    // (0, 2) is right beside the head: unreachable without circling. (15, -3) is easy.
    const food = [
      { x: 0, y: 2, value: 1 },
      { x: 15, y: -3, value: 1 },
    ];
    expect(act(bot, state({ food })).turn).toBeGreaterThan(0);
  });
});

describe("easy", () => {
  it("turns back toward the centre near the wall", () => {
    // Near the top edge, heading north-east: the centre is to the right.
    const me = self({ head: { x: 0, y: WORLD_RADIUS - 5 }, angle: Math.PI / 4 });
    expect(act(easy, state({ self: me })).turn).toBe(1);
  });

  it("ignores other snakes (that is what makes it easy)", () => {
    const s = state({ food: [{ x: 10, y: 0, value: 1 }], snakes: [wallAhead()] });
    expect(act(easy, s).turn).toBeCloseTo(0);
    // ...so it soon crashes in the arena the smarter bots survive.
    expect(drive(easy, { obstacles: clutter(), worldRadius: 50, ticks: 2000 })).not.toBeNull();
  });
});

describe.each(Object.entries(SMART))("%s: danger", (_, bot) => {
  it("turns away from a body across its road, even with food behind it", () => {
    const s = state({ food: [{ x: 10, y: 0, value: 1 }], snakes: [wallAhead()] });
    expect(Math.abs(act(bot, s).turn)).toBeGreaterThan(0.5);
  });

  it("turns away from the side a body blocks", () => {
    // A body running east just left of our road: veer right, away from it.
    const left = snake(line({ x: 2, y: 1.5 }, 0, 15), { head: null, angle: null });
    expect(act(bot, state({ snakes: [left] })).turn).toBeGreaterThan(0);
    const right = snake(line({ x: 2, y: -1.5 }, 0, 15), { head: null, angle: null });
    expect(act(bot, state({ snakes: [right] })).turn).toBeLessThan(0);
  });

  it("turns away from the wall ahead", () => {
    const me = self({ head: { x: WORLD_RADIUS - 8, y: 0 }, angle: 0 });
    expect(Math.abs(act(bot, state({ self: me })).turn)).toBe(1);
  });

  it("stays off the road just ahead of another head", () => {
    // A snake below us heading north will cross our road at x ≈ 6: we must not keep straight.
    const crossing = snake(line({ x: 6, y: -4 }, -Math.PI / 2, 6), { angle: Math.PI / 2 });
    const s = state({ food: [{ x: 14, y: 0, value: 1 }], snakes: [crossing] });
    expect(Math.abs(act(bot, s).turn)).toBeGreaterThan(0.3);
  });

  it("survives a cluttered arena for 2000 ticks", () => {
    for (const seed of [1, 2, 3]) {
      expect(drive(bot, { obstacles: clutter(), worldRadius: 50, ticks: 2000, seed })).toBeNull();
    }
  });
});

describe("medium vs hard: food choice", () => {
  // A plain pellet slightly to the right, a big one (remains of a dead snake) a bit farther left.
  const food = [
    { x: 6, y: -2, value: 1 },
    { x: 10, y: 4, value: 10 },
  ];

  it("medium takes the nearest food", () => {
    expect(act(medium, state({ food })).turn).toBeGreaterThan(0);
  });

  it("hard takes the best value per distance", () => {
    expect(act(hard, state({ food })).turn).toBeLessThan(0);
  });
});

describe("hard: hunting", () => {
  /** We are long and heading east; a small snake ahead-left is heading south across our road. */
  function hunt(o: { length?: number; preyLength?: number } = {}) {
    const segments = line({ x: 0, y: 0 }, Math.PI, 20);
    const me = self({ length: o.length ?? 100, segments });
    // Its head at (12, 4) heading south; its body trails north.
    const prey = snake(line({ x: 12, y: 4 }, Math.PI / 2, 6), {
      length: o.preyLength ?? 20,
      angle: -Math.PI / 2,
    });
    // Food up-left would pull a farmer the other way.
    return state({ self: me, snakes: [prey], food: [{ x: 4, y: 8, value: 1 }] });
  }

  it("cuts in front of a smaller snake and boosts for the cut", () => {
    // The point 10 ahead of the prey's head is (12, -6): to our right.
    const action = act(hard, hunt());
    expect(action.turn).toBeGreaterThan(0);
    expect(act(medium, hunt()).turn).toBeLessThan(0);
  });

  it("boosts only when lined up with the cut", () => {
    expect(act(hard, hunt()).boost).toBe(false); // still turning toward it
    const lined = hunt();
    // Same scene, but already heading for (12, -6).
    lined.self = self({
      length: 100,
      angle: Math.atan2(-6, 12),
      segments: line({ x: 0, y: 0 }, Math.atan2(-6, 12) + Math.PI, 20),
    });
    expect(act(hard, lined).boost).toBe(true);
    lined.self.length = 30; // too short to burn length on a boost
    expect(act(hard, lined).boost).toBe(false);
  });

  it("leaves bigger snakes alone", () => {
    expect(act(hard, hunt({ length: 100, preyLength: 90 })).turn).toBeLessThan(0);
  });
});

describe("chaos", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Turns chaos takes over `ticks` ticks of an empty arena for one seed. */
  function turns(seed: number, ticks = 50): number[] {
    const mem = chaos.init?.(info(seed));
    if (!mem) throw new Error("chaos has no init");
    return Array.from(
      { length: ticks },
      (_, t) => chaos.tick(state({ tick: t }), mem, () => {}).turn,
    );
  }

  it("is random but reproducible from info.seed, without Math.random or Date", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    expect(turns(7)).toEqual(turns(7));
    expect(turns(7)).not.toEqual(turns(8));
    expect(new Set(turns(7).map((t) => t.toFixed(3))).size).toBeGreaterThan(2);
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});
