import {
  CENTER,
  defineBot,
  nearestDanger,
  nearestFood,
  steerAway,
  steerToward,
} from "@zerosnake/sdk";

// The example bot from the SDK tests, written against the public API like any author's bot.
// It also logs and uses Math.random so the sandbox's log and RNG show up in its output.
export default defineBot({
  init(info) {
    return { mode: "farm" as "farm" | "flee", seed: info.seed, fled: 0, ticks: 0 };
  },
  tick(state, mem, log) {
    mem.ticks++;
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
    if (mem.ticks % 5 === 0) log("tick", mem.ticks, { mode: mem.mode, roll: Math.random() });
    return { turn: food ? steerToward(self, food) : 0 };
  },
});
