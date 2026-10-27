/**
 * Instrumented bot bundles, kept by the room per source (a version's bundle, or a house bot's).
 *
 * Every bundle is instrumented before it runs (#62): host work that grows with the bundle's size
 * (`WORST_INSTRUMENT_MS`). `Sandbox.startLife` does it inside the call the room marks and times as
 * the bot's `init`, so on a slow machine, or with a restart landing there, the backstop would blame
 * the bot for it. So the room instruments first, before any bot call of the batch is marked (a kill
 * there names nobody), and hands the result to the sandbox's own cache, which `startLife` reads.
 * The room keeps what it instrumented across sandboxes, so a rerun after an abandoned tick doesn't
 * instrument again; only a kill (which resets the isolate) does.
 */
import { type BotLife, type InstrumentResult, instrument, type Sandbox } from "@zerosnake/sandbox";
import type { LifeStarter } from "./sim.ts";

export class BundleCache {
  private readonly bundles = new Map<string, InstrumentResult>();

  constructor(
    private readonly instrumentBundle: (
      source: string,
    ) => InstrumentResult | Promise<InstrumentResult> = instrument,
  ) {}

  /**
   * `sources`: the bundles of every life in the room. Instruments those not cached yet and forgets
   * the others.
   */
  async prepare(sources: Iterable<string>): Promise<void> {
    const keep = new Set(sources);
    for (const source of this.bundles.keys()) if (!keep.has(source)) this.bundles.delete(source);
    for (const source of keep) {
      if (!this.bundles.has(source)) this.bundles.set(source, await this.instrumentBundle(source));
    }
  }

  get(source: string): InstrumentResult | undefined {
    return this.bundles.get(source);
  }
}

/** Starts lives in `sandbox` from the bundles `bundles` instrumented beforehand. */
export function lifeStarter(sandbox: Sandbox, bundles: BundleCache): LifeStarter {
  return {
    prepare: (sources) => bundles.prepare(sources),
    startLife(source, info): BotLife {
      const bundle = bundles.get(source);
      if (bundle) seedSandbox(sandbox, source, bundle);
      return sandbox.startLife(source, info);
    },
  };
}

/**
 * Puts `bundle` in the sandbox's instrument cache (`Sandbox.instrumented`, private, keyed by
 * source), so `startLife(source)` takes it instead of instrumenting `source` again.
 * TODO(packages/sandbox): a public way to start a life from an instrumented bundle would replace
 * this. `bundles.test.ts` checks that the sandbox uses what is put here.
 */
function seedSandbox(sandbox: Sandbox, source: string, bundle: InstrumentResult): void {
  const cache = (sandbox as unknown as { instrumented?: unknown }).instrumented;
  if (!(cache instanceof Map)) throw new Error("the sandbox has no instrument cache to seed");
  cache.set(source, bundle);
}
