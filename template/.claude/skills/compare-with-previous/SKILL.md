---

name: compare-with-previous
description: Compare the current ZeroSnake bot with a previous version (last commit, a git ref, or the deployed one) on identical seeds and report whether it is really better, worse or within noise. Use before deploying, after any strategy change, or when the author asks "is this better?".
---

# Compare with the previous version

## 1. Get the previous version

From git (default: the last commit; any ref works, e.g. a tag of the deployed version):

```sh
rm -rf .zerosnake/prev && mkdir -p .zerosnake/prev
git archive HEAD src | tar -x -C .zerosnake/prev     # → .zerosnake/prev/src/bot.ts
```

If the work is not committed yet and the author wants to compare against the working tree before
your change, copy `src/` aside before editing instead: `cp -r src .zerosnake/prev/`.
`.zerosnake/` is git-ignored.

## 2. Run both on the same seeds

Play each version as "you" on the same seeds against the same lineup (the default: easy, medium,
hard, chaos), so the comparison is fair and deterministic. A match is ~5–20 s; 20 seeds × 2
versions take a few minutes, so run the loop in the background if you can:

```sh
for seed in $(seq 1 20); do
  echo "seed $seed"
  npx zerosnake sim --headless --seed $seed | grep -E '\(you\)|ops per tick'
  npx zerosnake sim --headless --seed $seed --bot .zerosnake/prev/src/bot.ts | grep -E '\(you\)|ops per tick'
done
```

Each `(you)` row has lives, mean score per life, best, kills and deaths by cause for that seed;
the next line has the max interrupts used in one tick. Average the per-seed mean scores of each
version and work out the standard error (standard deviation / √seeds). Use more seeds when the
difference is small. Don't compare by putting both in one match (`--vs ./.zerosnake/prev/...`):
they then fight each other and one match is mostly luck.

**Monorepo checkout:** `npm run bench -- --seeds 40 .zerosnake/prev/src/bot.ts src/bot.ts` does
all of this in one table (pts/min and mean score ± error, deaths by cause, mean ticks, max ops).

## 3. Read the result honestly

- **Points per minute ± error** (the arena rates a version by its total score over its total time
  alive, over its last 200 lives; the bench's `pts/min` is the same, a life cut off by the end of a
  match counting with its score and time so far). Call it better or worse only if they differ by
  more than about twice the larger `±`; otherwise say "within noise" and suggest more seeds. The
  mean score per life is what the deploy checks' qualification compares with `easy`.
- **Deaths by cause:** did the change remove the cause it targeted? Did a new one appear?
- **Lives:** fewer lives on the same seeds means longer lives, usually more score; more deaths is a
  red flag even if the score held.
- **max ops:** must stay well under 10; a version that is close to the budget will time out in
  crowded arena rooms, and the deploy checks reject an average above 5.
- **The deploy checks:** `npx zerosnake test` on the current version. If it passes only narrowly
  (compare "mean score per life" with "easy in your seat" seed by seed), say so: its seeds come from
  the bundle's hash, so the next edit can fail. Improve the margin rather than re-rolling.

Report a short table (previous vs current) and a one-line verdict.

## The arena

The local matches use house bots only; the arena has other authors' bots. After a deploy:

- `npx zerosnake status` shows the deployed version's rating; the bot page on the site charts
  rating across versions;
- `npx zerosnake sim --vs ./.zerosnake/prev/src/bot.ts,hard` puts both versions in one match in
  the viewer, for the author to watch (don't run it yourself without `--headless`: it waits for the
  browser);
- later, with the MCP server connected, `compare_versions(a, b)` will compare two deployed versions
  on real arena lives.
