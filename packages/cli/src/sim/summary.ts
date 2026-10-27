import type { DeathCause } from "@zerosnake/engine";
import { TICK_RATE } from "@zerosnake/engine";
import { bold, dim, red, yellow } from "../term.ts";
import { describeVerdict, type MatchResult, verdictHint } from "./match.ts";
import type { SandboxVerdict, SimLife } from "./protocol.ts";

const CAUSE_ORDER: readonly DeathCause[] = ["collision", "wall", "timeout", "error", "retired"];

/** How a life ended, in plain language. */
export function describeDeath(life: SimLife): string {
  const d = life.death;
  if (!d) return "alive at the end";
  switch (d.cause) {
    case "collision":
      if (d.killerId === life.id) return "ran into its own body";
      return d.killerId ? `ran into ${d.killerId}` : "collided with another snake";
    case "wall":
      return "hit the wall";
    case "retired":
      return "retired at the life cap";
    case "timeout":
    case "error":
      return d.sandbox ? describeVerdict(d.sandbox) : d.cause;
  }
}

/** The headless summary: standings, then what happened to your bot. */
export function formatSummary(result: MatchResult): string {
  const out: string[] = [];
  const seconds = Math.round(result.ticks / TICK_RATE);
  out.push(
    bold(
      `Match: seed ${result.seed}, ${result.ticks} ticks (${formatDuration(seconds)} of game time)`,
    ),
    "",
  );

  const bots = [...result.bots].sort((a, b) => b.meanScore - a.meanScore);
  const rows = [
    ["", "bot", "lives", "mean score", "best", "kills", "deaths"],
    ...bots.map((b, i) => [
      `${i + 1}.`,
      b.you ? `${b.name} (you)` : b.name,
      String(b.lives),
      b.meanScore.toFixed(0),
      b.bestScore.toFixed(0),
      String(b.kills),
      formatCauses(b.deaths),
    ]),
  ];
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length))) ?? [];
  rows.forEach((r, i) => {
    const line = r
      .map((cell, c) =>
        c >= 2 && c <= 5 ? cell.padStart(widths[c] ?? 0) : cell.padEnd(widths[c] ?? 0),
      )
      .join("  ")
      .trimEnd();
    const isYou = i > 0 && bots[i - 1]?.you;
    out.push(i === 0 ? dim(line) : isYou ? bold(line) : line);
  });

  for (const bot of result.bots.filter((b) => b.you)) {
    out.push("", bold(`${bot.name}: lives`));
    const reasons = new Set<SandboxVerdict["reason"]>();
    for (const life of result.lives.filter((l) => l.bot === bot.name)) {
      const end = life.death?.tick ?? result.ticks;
      const score = life.death ? ` score ${life.death.score.toFixed(0)},` : "";
      const text = `  ${life.id}: ticks ${life.bornTick}–${end},${score} ${describeDeath(life)}`;
      out.push(life.death?.sandbox ? red(text) : text);
      if (life.death?.sandbox) reasons.add(life.death.sandbox.reason);
    }
    for (const reason of reasons) out.push(dim(`  ${verdictHint(reason, result.opBudget)}`));
    const budget = `max ${bot.maxOps}/${result.opBudget} ops per tick`;
    out.push("", `  ${bot.calls} calls, ${budget}`);
    if (bot.firstOverBudget) {
      const p = bot.firstOverBudget;
      out.push(
        yellow(`  ${bot.overBudget} calls over budget; first at tick ${p.tick} (${p.life})`),
      );
    }
    if (bot.firstError) {
      const p = bot.firstError;
      out.push(
        yellow(`  ${bot.errors} calls threw; first at tick ${p.tick} (${p.life}): ${p.message}`),
      );
    }
  }
  return out.join("\n");
}

function formatCauses(deaths: Partial<Record<DeathCause, number>>): string {
  const parts = CAUSE_ORDER.filter((c) => deaths[c]).map((c) => `${deaths[c]} ${c}`);
  return parts.length > 0 ? parts.join(", ") : "-";
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
