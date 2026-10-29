import {
  type Action,
  buildBotInfo,
  buildBotState,
  createWorld,
  spawnSnake,
  step,
} from "@zerosnake/engine";
import { DEFAULT_OP_BUDGET } from "@zerosnake/sandbox";
import { LOG_LIMIT_BYTES } from "@zerosnake/sdk";
import { describe, expect, it } from "vitest";
import { HOUSE_FILL_ORDER } from "./house.ts";
import { isHouseKind, type SimLife, startHouseLife } from "./house-life.ts";

/** A full room of house bots for `ticks` ticks; returns every tick's actions. */
function play(seed: number, ticks: number, restartAt?: number): string[] {
  const world = createWorld({ seed });
  const lives = new Map<string, SimLife>();
  const kinds = new Map<string, string>();
  const start = (id: string) => {
    const snake = world.snakes.find((s) => s.id === id);
    if (!snake) throw new Error(id);
    const info = buildBotInfo(world, snake, {
      opBudget: DEFAULT_OP_BUDGET,
      logLimitBytes: LOG_LIMIT_BYTES,
    });
    lives.set(id, startHouseLife(kinds.get(id) as string, info));
  };
  for (let i = 0; i < 20; i++) {
    const kind = HOUSE_FILL_ORDER[i % 4] as string;
    const id = `house-${kind}-0-${i}`;
    spawnSnake(world, { id, author: `house:${kind}` });
    kinds.set(id, kind);
    start(id);
  }
  const out: string[] = [];
  for (let t = 0; t < ticks; t++) {
    // A reload: every bot starts again (`init`, empty memory) at the saved frame.
    if (t === restartAt) for (const s of world.snakes) start(s.id);
    const actions: Record<string, Action> = {};
    for (const s of world.snakes) {
      const r = lives.get(s.id)?.tick(buildBotState(world, s));
      if (!r) continue;
      expect(r).toMatchObject({ outcome: "ok", work: 0, death: null });
      actions[s.id] = { turn: r.action.turn, boost: r.action.boost ?? false };
    }
    out.push(JSON.stringify(actions));
    step(world, actions);
    for (const d of world.deaths) lives.delete(d.id);
  }
  return out;
}

describe("native house lives", () => {
  it("play the same from the same frame: a rerun or a reload decides as the first run", () => {
    expect(play(5, 300)).toEqual(play(5, 300));
    // Two rooms reloaded at the same frame stay identical (chaos's randomness is `info.seed`).
    expect(play(6, 300, 150)).toEqual(play(6, 300, 150));
  });

  it("know the four house bots and nothing else", () => {
    for (const kind of HOUSE_FILL_ORDER) expect(isHouseKind(kind)).toBe(true);
    expect(isHouseKind("toString")).toBe(false);
    expect(() => startHouseLife("noob", {} as never)).toThrow(/no house bot/);
  });

  it("keep the last action when the bot throws, and never die of it", () => {
    const world = createWorld({ seed: 1 });
    const snake = spawnSnake(world, { id: "h", author: "house:easy" });
    const info = buildBotInfo(world, snake, { opBudget: 10, logLimitBytes: LOG_LIMIT_BYTES });
    const life = startHouseLife("easy", info);
    const ok = life.tick(buildBotState(world, snake));
    expect(ok.outcome).toBe("ok");
    for (let i = 1; i <= 5; i++) {
      const broken = life.tick(null as never);
      expect(broken).toMatchObject({ outcome: "error", errors: i, death: null });
      expect(broken.action).toEqual(ok.action);
    }
    expect(life.tick(buildBotState(world, snake))).toMatchObject({ outcome: "ok", errors: 0 });
  });
});
