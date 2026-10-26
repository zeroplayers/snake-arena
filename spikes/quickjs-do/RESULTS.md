# Spike #2: QuickJS inside a Durable Object

quickjs-emscripten 0.32 (`@jitl/quickjs-wasmfile-release-sync`), one runtime + context per bot,
8 MB memory limit, 256 KB stack, interrupt budget 1000 calls per tick.

State passed to each bot every tick: 60 food + 8 snakes × 25 segments, 12.4 KB of JSON.

Two bots ([src/bots.ts](src/bots.ts)):
- **typical**: nearest food + repulsion from nearby segments. What a first vibe-coded bot looks like.
- **heavy**: 16 candidate headings × 20-step lookahead against every visible segment (~64k distance checks). Upper end of what we expect.

## How to run

```bash
pnpm bench:node                      # Node, prints tables
pnpm dev                             # workerd on :8787
curl 'localhost:8787/bench?bots=20&ticks=100&kind=typical'
curl 'localhost:8787/safety'
```

## Results

|                                       | Node 24 (M1) | workerd local | Cloudflare (deployed) |
| ------------------------------------- | ------------ | ------------- | --------------------- |
| typical, µs per bot-tick              | ~330         | ~445          | _pending_             |
| typical, 20 bots, ms per tick         | 6.6          | 8.9           | _pending_             |
| heavy, µs per bot-tick                | ~7 500       | ~7 400        | _pending_             |
| heavy, 20 bots, ms per tick           | 150          | 148           | _pending_             |
| context setup                         | ~0.2–0.6 ms  | ~0.4 ms       | _pending_             |
| memory per context (QuickJS heap)     | ~90 KB       | ~90 KB        |                       |
| interrupts per tick (typical / heavy) | 0–1 / 13–20  | 0–1 / 13–19   |                       |

Takeaways so far:
- **Typical bots are cheap.** 20 bots at 10 tps use ~9% of a core. A room of 20 runs fine in real time and ~10× faster in accelerated mode.
- **Heavy bots are ~20× more expensive.** 20 heavy bots need ~150 ms per tick, so a full room of them can't run in real time at 10 tps. The per-tick budget must stop this, not room size.
- **Memory is a non-issue.** ~90 KB per context, the 128 MB DO limit is far away.
- **One interrupt ≈ 10k QuickJS "interrupt ticks"**, but wall time per interrupt varies 50–600 µs depending on the code (tight loop vs. property-heavy). The budget is only a rough proxy for time.

## Safety

| Hostile bot                     | Result                                             | Time       | Runtime usable after? |
| ------------------------------- | -------------------------------------------------- | ---------- | --------------------- |
| `while(true){}`                 | `InternalError: interrupted` after 1000 interrupts | ~60 ms     | yes                   |
| catastrophic regex `/(a+)+$/`   | interrupted                                        | ~265 ms    | yes                   |
| deep recursion                  | `stack overflow`                                   | ~1 ms      | yes                   |
| allocate until OOM              | `out of memory`                                    | **~2.6 s** | yes                   |
| `a.length = 1e8; a.indexOf(1)`  | runs to completion, **1 interrupt**                | **~4.4 s** | yes                   |
| `a.length = 1e8; a.includes(1)` | same                                               | **~3.9 s** | yes                   |
| `a.length = 1e7; a.join("")`    | same                                               | ~0.4 s     | yes                   |

**Native built-ins bypass the interrupt handler.** QuickJS only counts bytecode; loops inside C
functions (`indexOf`, `includes`, `join`, `fill` on sparse arrays…) never yield. A sparse array is
almost free in memory, so the memory limit doesn't catch it either. With `length = 2**32 - 1` a single
call would burn minutes of CPU and take down the whole room (DO CPU limit per invocation).

Inside Workers the clock is frozen during CPU work, so we can't add a wall-clock watchdog in the
isolate.

## Recommendation (draft, finalize after deployed numbers)

QuickJS is viable. Keep it, with these requirements for the sandbox (#8):

1. **Harden built-ins in a prelude**: wrap `Array.prototype` scanning methods (`indexOf`, `lastIndexOf`,
   `includes`, `join`, `fill`, `reverse`, `copyWithin`, …) and `TypedArray` equivalents to throw when
   `length` exceeds a cap (e.g. 1e5), or forbid setting `length` above the cap.
2. **Budget ≈ 10 interrupts per tick** to start (~5 ms for heavy code), tune with real bots.
3. **Room-level backstop**: simulation is deterministic, so if a batch dies on the DO CPU limit, replay
   it with bots isolated to find the culprit and ban that version.
4. **Lower the memory limit** to 2–4 MB: OOM takes ~2.5 s regardless of the limit, so this does not
   speed up the failure, but it caps the GC work per bot.
