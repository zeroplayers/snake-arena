# Spike #2: QuickJS inside a Durable Object

**Verdict: QuickJS works for us, with two mandatory fixes in the sandbox (#8): a capped wasm memory
and a hardened prelude for native array scans.**

Setup: quickjs-emscripten 0.32 (`@jitl/quickjs-wasmfile-release-sync`), one shared wasm module per
room, one runtime + context per bot, 8 MB runtime memory limit, 256 KB stack, interrupt budget
1000 calls per tick (benchmark only; see recommendations).

State passed to each bot every tick: 60 food + 8 snakes × 25 segments, 12.4 KB of JSON.

Bots ([src/bots.ts](src/bots.ts)):
- **typical**: nearest food + repulsion from nearby segments. What a first vibe-coded bot looks like.
- **heavy**: 16 candidate headings × 20-step lookahead against every visible segment (~64k distance checks). Upper end of what we expect.

## How to run

```bash
pnpm bench:node                      # Node, prints tables
pnpm dev                             # workerd on :8787
curl 'localhost:8787/bench?bots=20&ticks=100&kind=typical'
curl 'localhost:8787/safety'         # or ?case=memory-bomb|infinite-loop|deep-recursion|sparse-indexof
```

Deployed copy (Surnin Synergy account): `https://zerosnake-spike-quickjs.surnin-synergy.workers.dev`.
Production CPU time comes from `wrangler tail --format json` (`cpuTime`), because the clock inside
Workers is frozen during CPU work (confirmed: in-isolate timings read 0 ms).

## Performance

CPU per bot per tick:

| Bot     | Node 24 (M1) | workerd local | **Cloudflare** |
| ------- | ------------ | ------------- | -------------- |
| typical | ~330 µs      | ~445 µs       | **600–780 µs** |
| heavy   | ~7 000 µs    | ~7 400 µs     | **~11 600 µs** |

Per room tick:

|                 | Cloudflare CPU per tick | Share of a core at 10 tps | Max accelerated speed |
| --------------- | ----------------------- | ------------------------- | --------------------- |
| 10 typical bots | ~6.4 ms                 | 6%                        | ~150 ticks/s          |
| 20 typical bots | ~12–14 ms               | 13%                       | ~75 ticks/s           |
| 40 typical bots | ~31 ms                  | 31%                       | ~32 ticks/s           |
| 20 heavy bots   | ~233 ms                 | over budget               | ~4 ticks/s            |

Other numbers:
- **Cold start** (instantiate module + first context + one tick): ~32 ms CPU.
- **Context setup**: ~0.2–0.4 ms per bot.
- **Memory**: ~90 KB of QuickJS heap per context. The shared wasm heap starts at 16 MB.
- **Long batch**: 20 typical bots × 1000 ticks = 12.5 s CPU in one invocation. With the default
  30 s DO CPU limit, batches of ~500 ticks leave plenty of headroom.
- **Interrupts per tick**: typical 0–1, heavy 13–20. Wall time per interrupt varies 50–600 µs
  depending on the code, so the budget is only a rough proxy for time.

## Safety

| Hostile bot                                         | Result                                                                                                                        | Cloudflare CPU | DO survives?                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `while(true){}`                                     | `interrupted` after 1000 interrupts                                                                                           | ~60 ms         | yes                                                               |
| catastrophic regex `/(a+)+$/`                       | `interrupted`                                                                                                                 | ~265 ms (Node) | yes                                                               |
| deep recursion                                      | `stack overflow`                                                                                                              | ~1 ms          | yes                                                               |
| allocate until OOM, **uncapped wasm memory**        | heap grows to the 2 GB wasm max; on Cloudflare the isolate dies (`Invalid array buffer length`, next request is a cold start) | —              | **no**                                                            |
| allocate until OOM, **wasm memory capped at 64 MB** | `out of memory`                                                                                                               | 120–300 ms     | **yes**, honest bots keep running, memory is reused after dispose |
| `a.length = 1e8; a.indexOf(1)`                      | runs to completion with **0 interrupts**                                                                                      | **~4.1 s**     | yes, but it eats the room's CPU                                   |

### Finding 1: QuickJS's memory limit misses large allocations

`runtime.setMemoryLimit()` stops many small objects, but not big array backing stores or long
strings: a bot limited to 8 MB grew the heap to 1.6 GB (`new Array(10000).fill()` in a loop) or
500 MB (`'x'.repeat(1e5)` in a loop). quickjs-ng (`@jitl/quickjs-ng-wasmfile-release-sync`)
behaves the same. Because all bots in a room share one wasm module, one bot can kill the whole room.

**Fix (verified):** pass emscripten a `WebAssembly.Memory` with a `maximum` (we used 64 MB). Growth
past it fails inside malloc, QuickJS throws `out of memory` in the offending bot, the module stays
healthy, and disposing that runtime frees the memory for others. See `createVariant()` in
[src/worker.ts](src/worker.ts).

### Finding 2: native built-ins bypass the interrupt handler

QuickJS only counts bytecode. Loops inside C functions (`indexOf`, `includes`, `join`, `fill` on
sparse arrays…) never call the interrupt handler, and a sparse array costs almost no memory, so
neither limit catches it. `length = 2**32 - 1` would burn minutes of CPU in a single call and hit
the DO CPU limit. There's no way to add a wall-clock watchdog inside a Worker.

## Recommendations for the sandbox (#8)

1. **Cap the wasm memory per room module** (64 MB to start). Mandatory.
2. **Harden built-ins in a prelude**: wrap the `Array.prototype` and `TypedArray` scanning methods
   (`indexOf`, `lastIndexOf`, `includes`, `join`, `fill`, `reverse`, `copyWithin`, …) to throw when
   `length` exceeds a cap (e.g. 1e5), and block setting `length` above it. Mandatory. Test with the
   `sparse-indexof` case.
3. **Budget ≈ 10 interrupts per tick** to start (≈ 5–8 ms for heavy code on Cloudflare). The heavy
   lookahead bot (13–20 interrupts) would be cut off, which is intended: authors have to optimize.
   Tune with real bots.
4. **Kill a bot on its first OOM** and dispose its runtime immediately. To catch slow leaks, check
   `computeMemoryUsage()` per bot every N ticks (measure the cost in #8).
5. **Room backstop**: size batches so the worst case (all bots at full budget) fits the DO CPU
   limit. If a batch still dies, the simulation is deterministic: replay it with bots isolated to
   find the culprit and ban that version.
6. **Capacity**: plan for 20 bots per room. That's ~13% of a core in real time and ~75 ticks/s
   accelerated.
