/**
 * Bot sources used by the benchmark. They run inside QuickJS, so they are plain JS
 * strings. Each defines `__tick(json) -> json` and keeps memory between ticks.
 */

/** Nearest food plus a repulsion vector from nearby segments. Roughly what a first vibe-coded bot looks like. */
export const TYPICAL_BOT = `
let mem = { ticks: 0, lastTurn: 0 };
globalThis.__tick = function (json) {
  const s = JSON.parse(json);
  mem.ticks++;
  const hx = s.self.x, hy = s.self.y, ang = s.self.angle;
  let best = null, bd = Infinity;
  for (const f of s.food) {
    const dx = f.x - hx, dy = f.y - hy, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = f; }
  }
  let rx = 0, ry = 0;
  for (const sn of s.snakes) {
    for (const p of sn.segments) {
      const dx = hx - p.x, dy = hy - p.y, d2 = dx * dx + dy * dy + 1e-6;
      if (d2 < 400) { rx += dx / d2; ry += dy / d2; }
    }
  }
  let tx = best ? best.x - hx : Math.cos(ang), ty = best ? best.y - hy : Math.sin(ang);
  const tl = Math.hypot(tx, ty) || 1;
  tx = tx / tl + rx * 50; ty = ty / tl + ry * 50;
  let diff = Math.atan2(ty, tx) - ang;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const turn = Math.max(-1, Math.min(1, diff * 2));
  mem.lastTurn = turn;
  return JSON.stringify({ turn, boost: bd < 25 && mem.ticks % 10 === 0 });
};
`;

/**
 * Lookahead: for 16 candidate headings, march 20 steps and check every visible segment.
 * About 64k distance checks per tick — an ambitious bot, the upper end of what we expect.
 */
export const HEAVY_BOT = `
let mem = { ticks: 0 };
globalThis.__tick = function (json) {
  const s = JSON.parse(json);
  mem.ticks++;
  const hx = s.self.x, hy = s.self.y, ang = s.self.angle;
  const pts = [];
  for (const sn of s.snakes) for (const p of sn.segments) pts.push(p);
  let bestTurn = 0, bestScore = -Infinity;
  for (let c = 0; c < 16; c++) {
    const turn = -1 + (2 * c) / 15;
    let a = ang, x = hx, y = hy, score = 0;
    for (let step = 0; step < 20; step++) {
      a += turn * 0.1; x += Math.cos(a) * 2; y += Math.sin(a) * 2;
      let minD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i].x - x, dy = pts[i].y - y, d = dx * dx + dy * dy;
        if (d < minD) minD = d;
      }
      if (minD < 4) { score -= 1000 / (step + 1); break; }
      score += Math.min(minD, 100) / 100;
    }
    for (const f of s.food) {
      const dx = f.x - x, dy = f.y - y;
      score += 10 / (1 + Math.sqrt(dx * dx + dy * dy));
    }
    if (score > bestScore) { bestScore = score; bestTurn = turn; }
  }
  return JSON.stringify({ turn: bestTurn, boost: false });
};
`;

export const INFINITE_LOOP_BOT = `globalThis.__tick = function () { while (true) {} };`;

export const MEMORY_BOMB_BOT = `
const hoard = [];
globalThis.__tick = function () {
  for (;;) hoard.push(new Array(10000).fill(Math.random()));
};
`;

export const DEEP_RECURSION_BOT = `
function f(n) { return f(n + 1) + 1; }
globalThis.__tick = function () { return f(0); };
`;

export const BOTS = { typical: TYPICAL_BOT, heavy: HEAVY_BOT } as const;
export type BotKind = keyof typeof BOTS;
