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

```sh
npm run bench -- --seeds 40 .zerosnake/prev/src/bot.ts src/bot.ts
```

Both versions play the same seeds against the same house-bot lineup, so the comparison is fair
and deterministic. 40 seeds take well under a minute; use more when the difference is small.

## 3. Read the result honestly

- **Mean score ± error** per life (the arena rates a version by its mean life score over the last
  200 lives). Call it better or worse only if the means differ by more than about twice the larger
  `±`; otherwise say "within noise" and suggest more seeds.
- **Deaths by cause:** did the change remove the cause it targeted? Did a new one appear?
- **Mean ticks:** longer lives usually mean more score; a big drop is a red flag even if the score
  held.
- **max ops:** must stay well under 10; a version that is close to the budget will time out in
  crowded arena rooms.
- Both must beat `house:easy`, or the deploy is rejected.

Report a short table (previous vs current) and a one-line verdict.

## Later: the arena

The bench uses house bots only; the arena has other authors' bots. When available:

- `npx zerosnake sim --vs ./.zerosnake/prev/src/bot.ts,hard` puts both versions in one local match,
  in the viewer;
- `npx zerosnake status` shows the deployed version's rating; the bot page on the site charts rating
  across versions;
- with the MCP server connected, `compare_versions(a, b)` compares two deployed versions on real
  arena lives.
