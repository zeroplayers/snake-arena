/**
 * The test suite's CI shards: `.github/workflows/ci.yml` runs one job per shard.
 *
 *   node .github/test-shards.ts run <shard>   runs one shard (fails if it has no test files)
 *   node .github/test-shards.ts check         every test file is in exactly one shard, and ci.yml
 *                                             has a job for every shard and no other
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The CPU backstop's room tests wait out wall-clock kills (minutes each): a job per file.
const BACKSTOP = [
  "src/room.backstop.test.ts",
  "src/room.backstop-memory.test.ts",
  "src/room.backstop-restarts.test.ts",
];
const ARENA = ["--project", "@zerosnake/arena"];

const SHARDS: Record<string, string[]> = {
  arena: [...ARENA, ...BACKSTOP.flatMap((f) => ["--exclude", f])],
  "arena-backstop": [...ARENA, BACKSTOP[0] as string],
  "arena-backstop-memory": [...ARENA, BACKSTOP[1] as string],
  "arena-backstop-restarts": [...ARENA, BACKSTOP[2] as string],
  web: ["--project", "web"],
  packages: ["--project", "!web", "--project", "!@zerosnake/arena"],
};

const vitest = (args: string[]) =>
  execFileSync("pnpm", ["exec", "vitest", ...args], { encoding: "utf8" });

const files = (args: string[]) =>
  vitest(["list", "--filesOnly", ...args])
    .split("\n")
    .filter((line) => line.trim() !== "");

const [command, name] = process.argv.slice(2);

if (command === "run" && name !== undefined && name in SHARDS) {
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--passWithNoTests=false", ...(SHARDS[name] as string[])],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
} else if (command === "check") {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [shard, args] of Object.entries(SHARDS)) {
    const listed = files(args);
    if (listed.length === 0) problems.push(`shard ${shard} has no test files`);
    for (const file of listed) {
      const other = seen.get(file);
      if (other !== undefined) problems.push(`${file} is in shards ${other} and ${shard}`);
      seen.set(file, shard);
    }
  }
  const all = files([]);
  for (const file of all) if (!seen.has(file)) problems.push(`${file} is in no shard`);

  const jobs = [...readFileSync(".github/workflows/ci.yml", "utf8").matchAll(/- shard: (\S+)/g)]
    .map((m) => m[1] as string)
    .sort();
  const shards = Object.keys(SHARDS).sort();
  if (jobs.join() !== shards.join()) {
    problems.push(`ci.yml runs shards [${jobs.join(", ")}], want [${shards.join(", ")}]`);
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`${all.length} test files in ${shards.length} shards, each in exactly one`);
} else {
  console.error(`usage: test-shards.ts run <${Object.keys(SHARDS).join("|")}> | check`);
  process.exit(2);
}
