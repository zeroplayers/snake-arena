import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  type BotAction,
  type BotInfo,
  type BotState,
  createTickLog,
  type TickLog,
  utf8Length,
} from "@zerosnake/sdk";
import {
  type Intrinsics,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { PRELUDE } from "./prelude.ts";
import { checkSource } from "./source.ts";

/** Interrupt-handler calls allowed per `tick()`; use it as `BotInfo.opBudget`. */
export const DEFAULT_OP_BUDGET = 10;
/** Cap of the wasm heap shared by every bot of one {@link Sandbox}. */
export const DEFAULT_WASM_MEMORY_CAP_BYTES = 64 * 1024 * 1024;

/**
 * Native work units (≈ 1 ns of CPU each) allowed per unit of op budget. Native built-ins that
 * loop internally are charged in these units by the prelude; see `prelude.ts`.
 */
export const WORK_PER_OP = 1_000_000;

const WASM_PAGE = 64 * 1024;
/** The QuickJS emscripten build starts with 16 MB of heap. */
const WASM_INITIAL_PAGES = 256;
/** Budget for the host's own calls into the sandbox (error descriptions, counters). */
const HOUSEKEEPING_BUDGET = 50;

// TypeScript only types WebAssembly in the DOM and worker libs, so a Node-only program (the CLI)
// would not know it. These are the two pieces we use.
/** A compiled `WebAssembly.Module`. */
export type WasmModule = object;
interface WasmMemory {
  readonly buffer: ArrayBuffer;
  grow(pages: number): number;
}
const { Memory } = (
  globalThis as unknown as {
    WebAssembly: { Memory: new (d: { initial: number; maximum: number }) => WasmMemory };
  }
).WebAssembly;

/** Matches `Fault` in `@zerosnake/engine`: why the sandbox kills a snake. */
export type Fault = "timeout" | "error";

export interface SandboxOptions {
  /**
   * The compiled QuickJS wasm (`@jitl/quickjs-wasmfile-release-sync/wasm`). Required in Workers,
   * which cannot compile wasm from bytes at runtime: import the `.wasm` file and pass it here.
   * In Node it is loaded from disk when omitted.
   */
  wasmModule?: WasmModule;
  /**
   * Hard cap of the wasm heap shared by all bots in this sandbox. QuickJS's own per-runtime limit
   * misses large arrays and strings, so this is what stops one bot from growing the heap until
   * the isolate dies. Default {@link DEFAULT_WASM_MEMORY_CAP_BYTES}; at least 16 MiB.
   */
  wasmMemoryCapBytes?: number;
}

export interface LifeOptions {
  /**
   * Per-bot memory limit. Enforced twice: by QuickJS on each allocation (only catches big single
   * allocations under emscripten) and by a `computeMemoryUsage()` check every
   * `memoryCheckInterval` ticks. Over it, the bot dies with an `error` fault. Default 8 MiB.
   */
  memoryLimitBytes?: number;
  /** Ticks between memory checks (also checked once after init). Default 10. */
  memoryCheckInterval?: number;
  /** Default 256 KiB. */
  maxStackBytes?: number;
  /**
   * Array and typed-array methods that walk the whole array throw a RangeError above this
   * `length` (sparse arrays cost no memory, and native scans skip interrupt checks). Default 1e5.
   */
  maxArrayLength?: number;
  /** Op budget for evaluating the module plus `init()`. Default 100. */
  initOpBudget?: number;
  /** Consecutive over-budget ticks before death by `timeout`. Default 3. */
  maxStrikes?: number;
  /** Consecutive ticks that throw before death by `error`. Default 3. */
  maxErrors?: number;
}

/**
 * `skipped`: the shared heap ran out during this tick because of another bot (which was killed for
 * it). The tick's result is discarded (previous action) and it counts as neither strike nor error.
 */
export type TickOutcome = "ok" | "timeout" | "error" | "skipped";

/** Why a life ended inside the sandbox. */
export interface Death {
  /** Pass this to the engine's `FaultMap`. OOM and load failures are `error`. */
  fault: Fault;
  reason: "timeouts" | "errors" | "oom" | "load" | "crash";
  message: string;
}

export interface TickLogOutput {
  lines: string[];
  truncated: boolean;
}

export interface TickReport {
  /** Apply this. Unless `ok`, it is the previous tick's action (`{ turn: 0 }` at first). */
  action: BotAction;
  outcome: TickOutcome;
  /** The exception or the budget that ran out, when `outcome` is not `ok`. */
  error: string | null;
  /** Interrupt-handler calls during this tick; the budget is `info.opBudget`. */
  interrupts: number;
  /** Native work units charged this tick; the budget is `info.opBudget × WORK_PER_OP`. */
  work: number;
  /** `log()` output of this tick, even when it timed out or threw. */
  log: TickLogOutput;
  /** Consecutive timeouts so far, this one included. */
  strikes: number;
  /** Consecutive errors so far, this one included. */
  errors: number;
  /** Set on the tick the bot dies (and on every tick after). The runtime is already disposed. */
  death: Death | null;
}

/**
 * One QuickJS wasm instance with a capped heap, shared by many bot lives (one per room in the
 * arena, one per run in the CLI). Each life gets its own runtime and context inside it.
 */
export class Sandbox {
  private readonly qjs: QuickJSWASMModule;
  private readonly heap: Heap;

  private constructor(qjs: QuickJSWASMModule, heap: Heap) {
    this.qjs = qjs;
    this.heap = heap;
  }

  static async create(options: SandboxOptions = {}): Promise<Sandbox> {
    const cap = options.wasmMemoryCapBytes ?? DEFAULT_WASM_MEMORY_CAP_BYTES;
    const maximum = Math.floor(cap / WASM_PAGE);
    if (!(maximum >= WASM_INITIAL_PAGES)) {
      throw new RangeError(`wasmMemoryCapBytes must be at least ${WASM_INITIAL_PAGES * WASM_PAGE}`);
    }
    const memory = new Memory({ initial: WASM_INITIAL_PAGES, maximum });
    const heap = new Heap(memory);
    // The casts only bridge our minimal types to the library's WebAssembly ones.
    const variant = newVariant(baseVariant, {
      wasmMemory: memory as never,
      ...(options.wasmModule ? { wasmModule: options.wasmModule as never } : {}),
    });
    return new Sandbox(await newQuickJSWASMModuleFromVariant(variant), heap);
  }

  /** Current size of the shared wasm heap. It never shrinks, but freed memory is reused. */
  get heapBytes(): number {
    return this.heap.memory.buffer.byteLength;
  }

  /**
   * Starts a life: a fresh runtime and context, the hardened prelude, the bot module (an ESM
   * bundle that default-exports `defineBot({ init, tick })`) and `init(info)`.
   * Never throws for problems in the bot: a bot that fails to load comes back already dead.
   *
   * `info.opBudget` is the per-tick budget in interrupt-handler calls ({@link DEFAULT_OP_BUDGET}),
   * `info.seed` seeds `Math.random`, `info.logLimitBytes` caps `log()` output per tick.
   */
  startLife(source: string, info: BotInfo, options: LifeOptions = {}): BotLife {
    return new BotLife(this.qjs, this.heap, source, info, options);
  }
}

/** Emscripten tries this many sizes before its heap resize gives up (`emscripten_resize_heap`). */
const RESIZE_ATTEMPTS = 3;

/**
 * Watches the shared wasm heap. When it can't grow, malloc returns NULL and QuickJS throws
 * "out of memory" inside whichever bot was allocating, and that bot may catch it (or get a bare
 * `null` when even the error object can't be allocated). So the host notices on its own:
 * emscripten grows the heap through `memory.grow()`, and every attempt fails at the cap.
 */
class Heap {
  readonly memory: WasmMemory;
  /** Successful growths. */
  grows = 0;
  /** Resize requests where every attempt failed: an allocation failed for lack of heap. */
  exhausted = 0;
  /** Lives currently holding a runtime in this heap. */
  readonly lives = new Set<BotLife>();
  private failedAttempts = 0;

  constructor(memory: WasmMemory) {
    this.memory = memory;
    const grow = memory.grow.bind(memory);
    // An own property shadows WebAssembly.Memory.prototype.grow; emscripten calls memory.grow().
    memory.grow = (pages) => {
      try {
        const before = grow(pages);
        this.grows++;
        this.failedAttempts = 0;
        return before;
      } catch (e) {
        if (++this.failedAttempts % RESIZE_ATTEMPTS === 0) this.exhausted++;
        throw e;
      }
    };
  }

  /** Kills every live bot over its memory limit. Returns how many. */
  reclaim(): number {
    let killed = 0;
    for (const life of [...this.lives]) if (life.checkMemory()) killed++;
    return killed;
  }
}

/** Shorthand for {@link Sandbox.create}. */
export function createSandbox(options?: SandboxOptions): Promise<Sandbox> {
  return Sandbox.create(options);
}

/** Functions returned by the prelude's `setup`. */
interface Driver {
  begin: QuickJSHandle;
  load: QuickJSHandle;
  tick: QuickJSHandle;
  work: QuickJSHandle;
  describe: QuickJSHandle;
}

interface Vm {
  runtime: QuickJSRuntime;
  ctx: QuickJSContext;
  driver: Driver;
}

// Date and Proxy are off; BigInt and eval are removed by the prelude.
const INTRINSICS: Intrinsics = {
  BaseObjects: true,
  Date: false,
  Eval: true,
  StringNormalize: true,
  RegExp: true,
  JSON: true,
  Proxy: false,
  MapSet: true,
  TypedArrays: true,
  Promise: true,
};

const NO_ACTION: BotAction = { turn: 0 };

/** One life of one bot. Not reusable: start a new life for the next spawn. */
export class BotLife {
  /** Set once the bot is dead; its runtime is disposed at that moment. */
  death: Death | null = null;
  /** `log()` output from module evaluation and `init()`. */
  readonly loadLog: TickLogOutput;

  private vm: Vm | undefined;
  private readonly heap: Heap;

  private readonly info: BotInfo;
  private readonly opBudget: number;
  private readonly memoryLimit: number;
  private readonly memoryCheckInterval: number;
  private readonly maxStrikes: number;
  private readonly maxErrors: number;

  // Interrupt accounting for the current call into QuickJS.
  private interrupts = 0;
  private interruptLimit = Infinity;
  private forced = false;

  // Log accounting for the current tick; the SDK's TickLog does the actual truncation.
  private tickLog: TickLog;
  private readonly logLimit: number;
  private logUsed = 0;
  /** Set when the limit was reached by lines the SDK counts as 0 bytes (empty lines). */
  private logCut = false;

  private lastAction: BotAction = NO_ACTION;
  private strikes = 0;
  private errors = 0;
  private ticks = 0;

  constructor(
    qjs: QuickJSWASMModule,
    heap: Heap,
    source: string,
    info: BotInfo,
    options: LifeOptions,
  ) {
    this.heap = heap;
    this.info = info;
    if (!(info.opBudget > 0)) throw new RangeError("info.opBudget must be positive");
    this.opBudget = info.opBudget;
    this.logLimit = info.logLimitBytes;
    this.tickLog = createTickLog(info.logLimitBytes);
    this.memoryLimit = options.memoryLimitBytes ?? 8 * 1024 * 1024;
    this.memoryCheckInterval = options.memoryCheckInterval ?? 10;
    this.maxStrikes = options.maxStrikes ?? 3;
    this.maxErrors = options.maxErrors ?? 3;

    const problem = checkSource(source);
    if (problem) {
      this.loadLog = { lines: [], truncated: false };
      this.kill({ fault: "error", reason: "load", message: problem });
      return;
    }
    const exhaustedBefore = heap.exhausted;
    try {
      this.vm = this.boot(qjs, options);
      heap.lives.add(this);
      this.load(this.vm, source, options.initOpBudget ?? 100);
    } catch (e) {
      if (heap.exhausted === exhaustedBefore) {
        this.kill({ fault: "error", reason: "crash", message: hostMessage(e) });
      }
    }
    if (heap.exhausted !== exhaustedBefore) {
      // A half-loaded bot can't be resumed, so it dies even if another bot was the hog.
      heap.reclaim();
      this.kill({ fault: "error", reason: "oom", message: "the shared heap ran out during load" });
    }
    this.loadLog = this.flushLog();
    if (!this.death) this.checkMemory();
  }

  /**
   * Runs one tick. Over budget → previous action and a strike; throws → previous action and an
   * error; too many in a row (or out of memory) → `death` is set. On a dead life it returns the
   * death again without running anything.
   */
  tick(state: BotState): TickReport {
    const vm = this.vm;
    if (this.death || !vm) return this.report("error", this.death?.message);
    const { ctx, driver } = vm;
    const json = JSON.stringify(state);
    this.ticks++;
    this.flushLog();

    let outcome: TickOutcome = "ok";
    let error: string | null = null;
    let action: BotAction | null = null;
    let crash: string | null = null;
    let interrupts = 0;
    let work = 0;
    const { grows, exhausted } = this.heap;
    try {
      this.budget(this.opBudget);
      const stateArg = ctx.newString(json);
      const limitArg = ctx.newNumber(this.opBudget * WORK_PER_OP);
      const result = ctx.callFunction(driver.tick, ctx.undefined, stateArg, limitArg);
      stateArg.dispose();
      limitArg.dispose();
      interrupts = this.interrupts;
      // Checked even when the call returned normally: the bot may have swallowed the interrupt.
      const timedOut = this.overBudget();
      if (result.error) {
        error = timedOut ? null : this.describe(vm, result.error);
        result.error.dispose();
      } else {
        if (!timedOut) action = readAction(ctx, result.value);
        result.value.dispose();
      }
      if (timedOut) {
        outcome = "timeout";
        error = this.forced
          ? `over budget: native built-ins did more than ${this.opBudget * WORK_PER_OP} units of work`
          : `over budget: more than ${this.opBudget} interrupts`;
      } else if (result.error) {
        outcome = "error";
      }
      work = this.readWork(vm);
    } catch (e) {
      crash = hostMessage(e);
    }

    if (this.heap.exhausted !== exhausted) {
      // The shared heap ran out while this bot ran, whether or not it caught the error. Kill
      // whoever is over their limit; if that wasn't this bot, it was a victim.
      const killed = this.heap.reclaim();
      if (!this.death && killed > 0) {
        return this.report(
          "skipped",
          "the shared heap ran out because of another bot; this tick was discarded",
          interrupts,
          work,
        );
      }
      this.kill({
        fault: "error",
        reason: "oom",
        message: "out of memory: the shared heap ran out while this bot was running",
      });
    } else if (crash !== null) {
      outcome = "error";
      error = crash;
      this.kill({ fault: "error", reason: "crash", message: crash });
    } else if (isOutOfMemory(error)) {
      this.kill({ fault: "error", reason: "oom", message: error });
    }
    // kill() may have set death above; TypeScript still has it narrowed to null.
    const death = this.death as Death | null;
    if (death) return this.report(death.fault, death.message, interrupts, work);

    if (action) this.lastAction = action;
    this.strikes = outcome === "timeout" ? this.strikes + 1 : 0;
    this.errors = outcome === "error" ? this.errors + 1 : 0;
    if (this.strikes >= this.maxStrikes) {
      this.kill({
        fault: "timeout",
        reason: "timeouts",
        message: `${this.strikes} ticks in a row over budget`,
      });
    } else if (this.errors >= this.maxErrors) {
      this.kill({
        fault: "error",
        reason: "errors",
        message: `${this.errors} ticks in a row threw; last: ${error}`,
      });
    } else if (this.heap.grows !== grows || this.ticks % this.memoryCheckInterval === 0) {
      // A bot that grew the heap is checked at once, so it can't hold more than its limit.
      this.checkMemory();
    }
    return this.report(outcome, error, interrupts, work);
  }

  /** Frees the runtime. Safe to call more than once. */
  dispose(): void {
    const vm = this.vm;
    this.vm = undefined;
    this.heap.lives.delete(this);
    if (!vm) return;
    try {
      for (const h of Object.values(vm.driver)) h.dispose();
      vm.ctx.dispose();
      vm.runtime.dispose();
    } catch {
      // A runtime that ran out of memory may not free cleanly; its memory is lost, not corrupted.
    }
  }

  // ---- setup ----

  private boot(qjs: QuickJSWASMModule, options: LifeOptions): Vm {
    const runtime = qjs.newRuntime();
    try {
      return this.bootContext(runtime, options);
    } catch (e) {
      runtime.dispose();
      throw e;
    }
  }

  private bootContext(runtime: QuickJSRuntime, options: LifeOptions): Vm {
    runtime.setMemoryLimit(this.memoryLimit);
    runtime.setMaxStackSize(options.maxStackBytes ?? 256 * 1024);
    runtime.setInterruptHandler(() => {
      this.interrupts++;
      return this.overBudget();
    });
    const ctx = runtime.newContext({ intrinsics: INTRINSICS });

    const host = ctx.newObject();
    const emit = ctx.newFunction("emit", (line) =>
      this.emit(ctx.getString(line)) ? ctx.true : ctx.false,
    );
    const exhaust = ctx.newFunction("exhaust", () => {
      this.forced = true;
    });
    ctx.setProp(host, "emit", emit);
    ctx.setProp(host, "exhaust", exhaust);
    emit.dispose();
    exhaust.dispose();
    const opts = ctx.newObject();
    for (const [key, value] of Object.entries({
      seed: this.info.seed,
      maxArrayLength: options.maxArrayLength ?? 100_000,
      logLimitBytes: this.logLimit,
    })) {
      const v = ctx.newNumber(value);
      ctx.setProp(opts, key, v);
      v.dispose();
    }

    this.budget(Infinity);
    const setup = ctx.unwrapResult(ctx.evalCode(PRELUDE, "prelude.js"));
    const driver = ctx.unwrapResult(ctx.callFunction(setup, ctx.undefined, host, opts));
    setup.dispose();
    host.dispose();
    opts.dispose();
    const fns: Driver = {
      begin: ctx.getProp(driver, "begin"),
      load: ctx.getProp(driver, "load"),
      tick: ctx.getProp(driver, "tick"),
      work: ctx.getProp(driver, "work"),
      describe: ctx.getProp(driver, "describe"),
    };
    driver.dispose();
    return { runtime, ctx, driver: fns };
  }

  private load(vm: Vm, source: string, initOpBudget: number): void {
    const { ctx, driver } = vm;
    this.budget(initOpBudget);
    const limit = ctx.newNumber(initOpBudget * WORK_PER_OP);
    ctx.callFunction(driver.begin, ctx.undefined, limit).unwrap().dispose();
    limit.dispose();

    const evaluated = ctx.evalCode(source, "bot.js", { type: "module" });
    if (evaluated.error) {
      this.loadFailed(vm, evaluated.error, "evaluating the module");
      return;
    }
    const ns = evaluated.value;
    const state = ctx.getPromiseState(ns);
    if (state.type !== "fulfilled" || !state.notAPromise) {
      if (state.type === "fulfilled") state.value.dispose();
      if (state.type === "rejected") state.error.dispose();
      ns.dispose();
      this.kill({ fault: "error", reason: "load", message: "top-level await is not supported" });
      return;
    }
    const infoArg = ctx.newString(JSON.stringify(this.info));
    const loaded = ctx.callFunction(driver.load, ctx.undefined, ns, infoArg);
    infoArg.dispose();
    ns.dispose();
    if (loaded.error) {
      this.loadFailed(vm, loaded.error, "init()");
      return;
    }
    loaded.value.dispose();
    if (this.overBudget()) {
      this.kill({ fault: "timeout", reason: "load", message: "loading went over its op budget" });
    }
  }

  private loadFailed(vm: Vm, err: QuickJSHandle, phase: string): void {
    const timedOut = this.overBudget();
    const message = timedOut ? `${phase} went over its op budget` : this.describe(vm, err);
    err.dispose();
    this.kill({
      fault: timedOut ? "timeout" : "error",
      reason: isOutOfMemory(message) ? "oom" : "load",
      message,
    });
  }

  // ---- helpers ----

  /**
   * Whether the current budgeted call went over. The interrupt handler keeps failing every check
   * once this is true, and the host also checks it after the call returns, because QuickJS turns
   * an interrupt inside a Promise executor or async function into a rejection the bot can catch.
   */
  private overBudget(): boolean {
    return this.forced || this.interrupts > this.interruptLimit;
  }

  /** Resets interrupt accounting for the next call into QuickJS. */
  private budget(limit: number): void {
    this.interrupts = 0;
    this.interruptLimit = limit;
    this.forced = false;
  }

  /** Calls a driver function under the housekeeping budget and converts its result. */
  private call<T>(
    { ctx }: Vm,
    fn: QuickJSHandle,
    args: QuickJSHandle[],
    read: (h: QuickJSHandle) => T,
  ): T {
    this.budget(HOUSEKEEPING_BUDGET);
    const out = ctx.unwrapResult(ctx.callFunction(fn, ctx.undefined, ...args));
    try {
      return read(out);
    } finally {
      out.dispose();
    }
  }

  private readWork(vm: Vm): number {
    try {
      return this.call(vm, vm.driver.work, [], (h) => vm.ctx.getNumber(h));
    } catch {
      return 0;
    }
  }

  /** Message for a thrown value, read without running bot code. */
  private describe(vm: Vm, err: QuickJSHandle): string {
    try {
      return this.call(vm, vm.driver.describe, [err], (h) => vm.ctx.getString(h));
    } catch {
      return "uncaught exception (could not be described)";
    }
  }

  /**
   * Host side of `log()`: returns false once the byte limit is reached. The SDK's TickLog counts
   * an empty line as 0 bytes, so here every line costs at least 1 byte; otherwise `log('')` in a
   * loop could keep an unbounded number of lines.
   */
  private emit(line: string): boolean {
    const size = utf8Length(line);
    if (size === 0 && this.logUsed + 1 > this.logLimit) {
      this.logCut = true;
      return false;
    }
    this.tickLog.log(line);
    if (this.logUsed + size > this.logLimit) {
      this.logUsed = this.logLimit + 1;
      return false;
    }
    this.logUsed += Math.max(size, 1);
    return true;
  }

  private flushLog(): TickLogOutput {
    const out = this.tickLog.flush();
    if (this.logCut) out.truncated = true;
    this.logUsed = 0;
    this.logCut = false;
    return out;
  }

  /**
   * Kills the bot if it uses more than its memory limit; returns whether it did. Deterministic
   * per bot when run on a fixed schedule (it only depends on the bot's own allocations).
   */
  checkMemory(): boolean {
    if (this.death) return false;
    let used: number;
    try {
      used = this.memoryUsed();
    } catch {
      return false; // measuring allocates; with the heap full it can fail
    }
    if (used <= this.memoryLimit) return false;
    this.kill({
      fault: "error",
      reason: "oom",
      message: `out of memory: ${used} bytes in use, limit ${this.memoryLimit}`,
    });
    return true;
  }

  /** QuickJS's own estimate from walking the heap: ~10–50 µs for a typical bot. */
  memoryUsed(): number {
    if (!this.vm) return 0;
    const { runtime, ctx } = this.vm;
    this.budget(HOUSEKEEPING_BUDGET);
    const usage = runtime.computeMemoryUsage();
    const used = ctx.getProp(usage, "memory_used_size");
    const bytes = ctx.getNumber(used);
    used.dispose();
    usage.dispose();
    return bytes;
  }

  private kill(death: Death): void {
    if (this.death) return;
    this.death = death;
    this.dispose();
  }

  private report(
    outcome: TickOutcome,
    error?: string | null,
    interrupts = 0,
    work = 0,
  ): TickReport {
    return {
      action: this.lastAction,
      outcome,
      error: error ?? null,
      interrupts,
      work,
      log: this.flushLog(),
      strikes: this.strikes,
      errors: this.errors,
      death: this.death,
    };
  }
}

function readAction(ctx: QuickJSContext, value: QuickJSHandle): BotAction {
  const turnHandle = ctx.getProp(value, 0);
  const boostHandle = ctx.getProp(value, 1);
  const turn = ctx.getNumber(turnHandle);
  const boost = ctx.dump(boostHandle) === true;
  turnHandle.dispose();
  boostHandle.dispose();
  return boost ? { turn, boost } : { turn };
}

function isOutOfMemory(message: string | null): message is string {
  return message?.startsWith("InternalError: out of memory") ?? false;
}

function hostMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
