/**
 * One simulated room: a fixed composition of house bots, each respawned as soon as it dies, so
 * the composition holds for the whole run. Every life that starts in [warmup, ticks) is played
 * to its end and recorded; later lives are not, so long lives aren't undercounted.
 */
import { buildBotInfo, buildBotState, createWorld, spawnSnake, step } from "@zerosnake/engine";
import { type HouseBotName, houseBots } from "@zerosnake/house-bots";

export type Composition = Partial<Record<HouseBotName, number>>;

export interface Life {
  kind: HouseBotName;
  score: number;
  ticks: number;
}

export interface MatchOptions {
  composition: Composition;
  seed: number;
  ticks: number;
  warmup: number;
}

export function runMatch({ composition, seed, ticks, warmup }: MatchOptions): Life[] {
  const world = createWorld({ seed });
  const bots = new Map<string, { kind: HouseBotName; mem: object; startTick: number }>();
  const spawn = (id: string, kind: HouseBotName) => {
    const snake = spawnSnake(world, { id, author: id });
    const bot = houseBots[kind];
    const info = buildBotInfo(world, snake, { opBudget: 0, logLimitBytes: 1024 });
    bots.set(id, { kind, mem: bot.init?.(info) ?? {}, startTick: world.tick });
  };
  let i = 0;
  for (const [kind, count] of Object.entries(composition) as [HouseBotName, number][]) {
    for (let k = 0; k < count; k++) spawn(`${kind}#${i++}`, kind);
  }

  const lives: Life[] = [];
  const log = () => {};
  // Lives started before `ticks` that are still running.
  let pending = bots.size;
  while (pending > 0) {
    const actions: Record<string, { turn: number; boost?: boolean }> = {};
    for (const snake of world.snakes) {
      const b = bots.get(snake.id);
      if (b) actions[snake.id] = houseBots[b.kind].tick(buildBotState(world, snake), b.mem, log);
    }
    step(world, actions);
    for (const d of world.deaths) {
      const b = bots.get(d.id);
      if (!b) continue;
      if (b.startTick < ticks) {
        pending--;
        if (b.startTick >= warmup) lives.push({ kind: b.kind, score: d.score, ticks: d.lifeTicks });
      }
      spawn(d.id, b.kind);
      if (world.tick < ticks) pending++;
    }
  }
  return lives;
}
