import { type Node, parse } from "acorn";
import { checkSource } from "./source.ts";
import { Types } from "./types.ts";

/**
 * Load-time cost metering for bot bundles.
 *
 * QuickJS polls its interrupt handler about once per 10 000 branches or calls, however much
 * straight-line code runs in between, so an interrupt budget alone lets a long loop body run for
 * hundreds of ms per tick (#60). Instead, every bundle is rewritten before it is evaluated so that
 * it pays for its own code:
 *
 * - Code is split into regions: the module body, each function body, each loop body (one charge
 *   per iteration) and large `if`/`switch` branches. Code can only run again by entering a region
 *   again (a call or the next iteration), so charging a region's whole static cost on entry bounds
 *   the work between two charges by the size of the code. Untaken branches inside a region are
 *   charged too; that only over-estimates.
 * - A charge is `if ((__zs_g -= cost) < 0) __zs_o();`: `__zs_g` is a module-scoped `var` holding
 *   the units left in the current phase, and `__zs_o` makes the host fail the next interrupt
 *   check (an uncatchable error).
 * - Syntax whose cost grows with data rather than code calls a helper that charges by size first:
 *   object spread and rest (`__zs_k`), `for…in` (`__zs_f`). Array spread, for-of and array
 *   destructuring go through the array iterator, which the prelude charges.
 * - Exceptions: QuickJS writes a backtrace for every Error, decoding the line of every frame from
 *   the start of its function, so one exception at full stack depth in a large function costs up
 *   to ~100 ms. Every `catch` (and every `finally` that can swallow an exception) charges by the
 *   length of the caught error's `stack` (`__zs_x`), at a per-char rate scaled by the largest
 *   function of this bundle; the prelude does the same for `new Error()`.
 * - Strings: comparing, hashing or converting a string to a number runs in C in time linear in
 *   its length (up to ~15 ns per char for `+"0.1111…"`), however cheap the operator looks. So
 *   every place a string operand can reach such an operation charges its length at that op's
 *   rate (`(typeof v === "string" && (__zs_g -= v.length * rate) < 0 && __zs_o(), v)`):
 *   comparisons, arithmetic, `switch`, property keys, `in`, call arguments (a built-in may
 *   convert them), return and yield values (`valueOf`, getters and iterators feed built-ins),
 *   and values stored where a number is expected (`a[i] = v`, `a.length = v`). Every string is
 *   also capped at {@link MAX_STRING_LENGTH}: `+` and `+=` results go through `__zs_n`, string
 *   literals are rejected above it, and the prelude caps every built-in that builds a string.
 *   Compound assignments and updates of a member whose object or key isn't a plain name go
 *   through a small accessor object (`__zs_w(obj, key).v += x`), so the value can be checked
 *   before it is stored. Spread arguments (`f(...xs)`) go through `__zs_a`, which charges them.
 * - Built-ins can drop an exception without any `catch` seeing it: closing an iterator after an
 *   exception (for-of, destructuring, Array.from) ignores what its `return()` throws. So every
 *   function body is wrapped in a `catch` that charges the exception on its way out (`__zs_r`;
 *   the backtrace part only once per error object) and rethrows it.
 *
 * The header registers the counter with the prelude (which charges native built-ins against the
 * same counter) and leaves nothing on `globalThis`. Bot code can't touch the counter: identifiers
 * starting with `__zs` are rejected, the counter is a lexical binding (not a property), and there
 * is no `eval`, `with` or `Function`.
 *
 * The output keeps every line of the input on the same line (the header goes before the first
 * one), so error positions still point into the bundle.
 */

/** Cost units (≈ 1 ns of CPU on an M1 each) per unit of static code weight. */
export const UNITS_PER_WEIGHT = 8;

/** Branches of an `if` or `switch` heavier than this get their own charge. */
const SPLIT_WEIGHT = 48;

/**
 * Most syntax nodes in one function's own code (nested functions excluded). A backtrace decodes
 * the line of each frame from the start of its function, so this caps one exception at full stack
 * depth (~1 100 frames with the default 256 KiB stack) to ~8 ms. Honest bots stay far below
 * (house bots: ≤ 250).
 */
export const MAX_FUNCTION_NODES = 3000;

/** Brackets nested deeper than this are rejected before parsing (the parser recurses). */
const MAX_NESTING = 200;

/**
 * Most `\p{` and `\P{` (property escapes) in a bundle, counted before parsing: the parser
 * validates each one in regex literals, which takes up to ~0.6 ms (`\p{RGI_Emoji}` with the v
 * flag; a 14 KB literal of them took 0.7 s). Honest bots use a handful.
 */
const MAX_PROPERTY_ESCAPES = 64;

/**
 * Longest string bot code can build or embed (UTF-16 units). Operators that walk a string are
 * charged by its length, but a few built-ins still read strings that the bot stored earlier
 * (see the README's known gaps); this cap bounds what one such read can cost.
 */
export const MAX_STRING_LENGTH = 16_384;

/**
 * Units per char of a string operand, by the most a C operation on it can cost per char (M1):
 * converting to a number (~15 ns for a long decimal like "0.1111…"), hashing it as a property or
 * Map key (~1.4 ns; charged twice where a compound assignment reads and writes the same key) and
 * strict equality (memcmp, ~0.5 ns).
 */
const K_NUMBER = 16;
const K_KEY = 4;
const K_EQUAL = 1;
/** Weight of one inline string check. */
const W_CHECK = 2;
/**
 * Syntax nodes one inline check adds to its function. They count toward the function size
 * limit and the backtrace rate: a backtrace decodes each frame's function from its start, so a
 * function full of checks costs that much more per frame.
 */
const CHECK_NODES = 16;
/**
 * Converting a number to a string (a property key): ≈ 0.2–0.8 µs, but up to ≈ 36 µs for a value
 * printed with a 3-digit exponent. Int32 values are checked inline and skip the helper; the
 * prelude charges the rest by value (same rates as `DTOA` and `DTOA_MAX` in prelude.ts).
 */
const DTOA_UNITS = 800;
const DTOA_MAX_UNITS = 40_000;

/**
 * Compiling a regex, in units (same estimate as `compileCost` in prelude.ts): per char of the
 * pattern, per char more with the i flag (case folding a class: up to ~16 µs per char), per
 * property escape with u or with v (properties of strings, up to ~1.6 ms each). QuickJS compiles
 * the literals while it parses the bundle, before any charge can run, so a bundle whose literals
 * would take more than {@link MAX_REGEX_UNITS} is rejected instead (a 14 KB `/\p{RGI_Emoji}…/v`
 * literal took ~0.9 s per load and ended in a wasm memory fault; re-verification of #62).
 */
const REGEX_CHAR_UNITS = 120;
const REGEX_FOLD_UNITS = 20_000;
const REGEX_PROPERTY_UNITS = 100_000;
const REGEX_PROPERTY_V_UNITS = 2_000_000;
/** Most units of regex compilation the literals of one bundle may cost (a fifth of a load). */
const MAX_REGEX_UNITS = 20_000_000;

/** Charged for each caught exception, plus the per-char backtrace cost below. */
const EXCEPTION_UNITS = 4000;
/**
 * Backtrace cost per char of `stack`, in units: the fixed part per frame (name lookup and
 * formatting, ≈ 0.5 µs for a frame of ≥ 20 chars) and the line lookup, which decodes the frame's
 * function from its start (≈ 1.6 ns per node of that function, so ÷ 20 chars per frame).
 */
const BACKTRACE_UNITS_PER_CHAR = 30;
const BACKTRACE_UNITS_PER_CHAR_PER_NODE = 0.08;

/** Names the instrumentation uses. Bot code may not use any identifier starting with this. */
const RESERVED = "__zs";
const COUNTER = "__zs_g";
const OVERRUN = "__zs_o";
const KEYS = "__zs_k";
const FOR_IN = "__zs_f";
const CAUGHT = "__zs_x";
const CAUGHT_VAR = "__zs_e";
const TEMP = "__zs_t";
const NEW_STRING = "__zs_n";
const NEW_KEY = "__zs_y";
const KEY = "__zs_d";
const MEMBER = "__zs_w";
const SPREAD_ARGS = "__zs_a";
const LEAVING = "__zs_r";
const HEAD = "__zs_v";
/** Global the prelude defines for the header (same name in prelude.ts); the call deletes it. */
const METER_GLOBAL = "__zs_meter";

export type InstrumentResult =
  | {
      ok: true;
      /** The bundle to evaluate. */
      source: string;
      /** Most syntax nodes in one function's own code (sets the backtrace rate). */
      maxFunctionNodes: number;
    }
  | { ok: false; error: string };

/**
 * Rewrites a bot bundle (ESM) so that it meters its own CPU. Run on every bundle before it is
 * evaluated; `Sandbox.startLife` does this itself, so callers only need it to report problems
 * early. Deterministic: the same source always gives the same output.
 *
 * Rejects (with a message for the bot author): what {@link checkSource} rejects, syntax errors,
 * `import`/`export … from`, identifiers starting with `__zs`, object rest patterns other than a
 * plain `const {a, ...rest} = value` / `({a, ...rest} = value)`, destructuring in a `catch`
 * clause, functions over {@link MAX_FUNCTION_NODES} syntax nodes, and brackets nested more than
 * 200 deep (other nesting deep enough to exhaust the host's stack is rejected too; where that
 * happens depends on the engine).
 */
export function instrument(source: string): InstrumentResult {
  const problem = checkSource(source) ?? checkNesting(source) ?? checkPropertyEscapes(source);
  if (problem) return { ok: false, error: problem };
  let ast: Node;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch (e) {
    return { ok: false, error: `SyntaxError: ${(e as Error).message}` };
  }
  try {
    return new Instrumenter(source).run(ast);
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, error: e.message };
    if (e instanceof RangeError) {
      return { ok: false, error: "the bundle is nested too deeply to instrument" };
    }
    throw e;
  }
}

class Rejected extends Error {}

/** Static weight of code reached since the last charge. */
interface Region {
  weight: number;
}

/** Where a region's charge goes, decided once its weight is known. */
type Placement =
  /** `{` of a block: the charge goes right after it. */
  | { kind: "block"; pos: number }
  /** A single statement: wrapped as `{ charge; statement }`. */
  | { kind: "statement"; node: Node }
  /** An expression: wrapped as `(charge, expression)`. */
  | { kind: "expression"; node: Node }
  /** Before a statement in a list (a `switch` case). */
  | { kind: "before"; pos: number }
  /** A synthetic first private field of a class with instance fields. */
  | { kind: "field"; pos: number };

interface Charge {
  region: Region;
  at: Placement;
  /** Charge the caught exception held in this variable too. */
  caught?: string;
}

interface Edit {
  pos: number;
  text: string;
  /** Closing text goes before opening text at the same position; see `apply`. */
  close: boolean;
  /**
   * Size of the wrapped range: at one position, outer opens first and inner closes first. An
   * opening with span 0 inserts statements (a charge, `try{`, `var`) and opens before every
   * finite span there, so it never lands inside an expression wrap of the code that follows.
   */
  span: number;
  /** Source chars replaced by `text` (an operator or bracket; newlines in them are kept). */
  del?: number;
  /** Text inserted here is this source range, with the edits inside it (they move with it). */
  move?: { from: number; to: number; before: string; after: string };
}

interface FunctionState {
  /** Syntax nodes of this function's own code (nested functions excluded). */
  nodes: number;
  /** Its code uses the temporary: it gets a local one (twice as fast as the module's). */
  temp?: boolean;
  /** Its return values only reach bot code (see `Types.callOnly`), so they aren't checked. */
  callOnly?: boolean;
}

type AnyNode = Node & Record<string, unknown>;

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range"]);

/**
 * Weights, calibrated on adversarial loops (the shapes in metering.test.ts, run for longer) so
 * that one unit costs at most ~1 ns on an M1: creating a closure, an object or array, a class; a
 * call, a `new`; a regex literal; a property or element of a literal; one loop iteration.
 */
const W_CLOSURE = 40;
const W_ALLOC = 16;
const W_CLASS = 320;
const W_CALL = 8;
const W_NEW = 24;
const W_REGEX = 40;
const W_PROPERTY = 6;
const W_ELEMENT = 4;
const W_FIELD = 8;
const W_ITERATION = 4;
/** `+` and `+=` may build a new string. */
const W_PLUS = 2;
/** A template literal with substitutions calls the prelude's wrapped `String.prototype.concat`. */
const W_TEMPLATE = 120;

class Instrumenter {
  private readonly source: string;
  private readonly charges: Charge[] = [];
  private readonly edits: Edit[] = [];
  private region: Region = { weight: 0 };
  private fn: FunctionState = { nodes: 0 };
  private maxFunctionNodes = 0;
  private maxParamWeight = 0;
  private regexUnits = 0;
  /**
   * Starts of expression statements in a statement list. Text inserted there must not start
   * with `(`: without a semicolon, the previous line would become a call (`a = b` + `(x)`).
   */
  private readonly statementStarts = new Set<number>();
  /** Which names only ever hold numbers: their string checks are left out. */
  private types!: Types;

  constructor(source: string) {
    this.source = source;
  }

  run(ast: Node): InstrumentResult {
    this.types = new Types(ast);
    const top = this.region;
    const module = this.fn;
    this.markStatements((ast as AnyNode).body as Node[]);
    for (const stmt of (ast as AnyNode).body as Node[]) this.visit(stmt);

    for (const c of this.charges) this.place(c);
    const tick =
      BACKTRACE_UNITS_PER_CHAR + BACKTRACE_UNITS_PER_CHAR_PER_NODE * this.maxFunctionNodes;
    const load =
      BACKTRACE_UNITS_PER_CHAR +
      BACKTRACE_UNITS_PER_CHAR_PER_NODE * Math.max(this.maxFunctionNodes, module.nodes);
    const exception = EXCEPTION_UNITS + this.maxParamWeight * UNITS_PER_WEIGHT;
    const header =
      `var ${COUNTER}=0,${TEMP};const{o:${OVERRUN},k:${KEYS},f:${FOR_IN},x:${CAUGHT},` +
      `n:${NEW_STRING},y:${NEW_KEY},w:${MEMBER},a:${SPREAD_ARGS},r:${LEAVING},d:${KEY}}=` +
      `${METER_GLOBAL}(function(n){${COUNTER}=n},function(){return ${COUNTER}},` +
      `${Math.ceil(tick)},${Math.ceil(load)},${exception});` +
      chargeStatement(Math.ceil(top.weight * UNITS_PER_WEIGHT));
    // After a hashbang line, so it stays first; otherwise before line 1.
    const at = this.source.startsWith("#!") ? this.source.indexOf("\n") + 1 : 0;
    this.edits.push({ pos: at, text: header, close: false, span: Infinity });
    return {
      ok: true,
      source: this.apply(),
      maxFunctionNodes: this.maxFunctionNodes,
    };
  }

  // ---- walking ----

  private add(weight: number): void {
    this.region.weight += weight;
  }

  private addCheck(): void {
    this.add(W_CHECK);
    this.fn.nodes += CHECK_NODES;
  }

  /** Visits `node` into a fresh region and returns that region's weight. */
  private measure(node: Node | null | undefined): number {
    if (!node) return 0;
    const saved = this.region;
    this.region = { weight: 0 };
    this.visit(node);
    const { weight } = this.region;
    this.region = saved;
    return weight;
  }

  /** Visits `node` as its own region and charges it at `at`. */
  private charged(nodes: Node[], at: Placement, extra = 0, caught?: string): Region {
    const saved = this.region;
    const region = { weight: extra };
    this.region = region;
    for (const n of nodes) this.visit(n);
    this.region = saved;
    this.charges.push(caught === undefined ? { region, at } : { region, at, caught });
    return region;
  }

  /** A branch: its own region if heavy, otherwise part of the current one. */
  private branch(nodes: Node[], at: Placement): void {
    const saved = this.region;
    const region = { weight: 0 };
    this.region = region;
    for (const n of nodes) this.visit(n);
    this.region = saved;
    if (region.weight > SPLIT_WEIGHT) {
      this.charges.push({ region, at });
    } else {
      this.region.weight += region.weight;
    }
  }

  private visitChildren(node: AnyNode): void {
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) this.visit(c);
      } else if (isNode(v)) {
        this.visit(v);
      }
    }
  }

  private visit(node: Node): void {
    this.fn.nodes++;
    const n = node as AnyNode;
    switch (n.type) {
      case "Identifier":
        this.checkName(n.name as string, n);
        this.add(1);
        return;
      case "PrivateIdentifier":
        this.checkName(n.name as string, n);
        this.add(1);
        return;
      case "Literal":
        this.checkLiteral(n);
        this.add(n.regex ? W_REGEX : 1);
        return;
      case "TemplateElement": {
        const value = n.value as { cooked: string | null; raw: string };
        if (Math.max(value.raw.length, value.cooked?.length ?? 0) > MAX_STRING_LENGTH) {
          throw this.reject(n, `this template is longer than ${MAX_STRING_LENGTH} chars`);
        }
        this.add(1);
        return;
      }
      case "ImportDeclaration":
      case "ImportExpression":
      case "ExportAllDeclaration":
        throw this.reject(n, "bots can't import anything: bundle every dependency into one file");
      case "ExportNamedDeclaration":
        if (n.source) {
          throw this.reject(n, "bots can't import anything: bundle every dependency into one file");
        }
        this.visitChildren(n);
        return;
      case "ExportSpecifier":
        return;
      case "MetaProperty":
        this.add(1);
        return;
      case "MemberExpression":
        this.add(1);
        this.visit(n.object as Node);
        if (n.computed) {
          this.visit(n.property as Node);
          this.check(n.property as Node, K_KEY);
        }
        return;
      case "Property":
        this.add(W_PROPERTY);
        if (n.computed) {
          this.visit(n.key as Node);
          // A computed key can name a function (`{ get [k]() {} }` is "get " + k), so it is capped.
          this.check(n.key as Node, K_KEY, NEW_KEY);
        }
        // `{ a }` has the same Identifier as key and value.
        this.visit(n.value as Node);
        return;
      case "LabeledStatement":
        this.visit(n.body as Node);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        this.add(1);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.visitFunction(n);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        this.visitClass(n);
        return;
      case "CallExpression":
      case "NewExpression":
        this.add(n.type === "NewExpression" ? W_NEW : W_CALL);
        this.visit(n.callee as Node);
        // A built-in may convert or hash any argument; the bot's own functions check their uses.
        if (this.types.ownFunction(n.callee as AnyNode)) {
          this.visitChildren({ ...n, callee: null } as AnyNode);
          return;
        }
        for (const a of n.arguments as AnyNode[]) {
          if (a.type === "SpreadElement") {
            this.add(2);
            this.wrapCall(SPREAD_ARGS, a.argument as Node);
            this.visit(a.argument as Node);
          } else {
            this.visit(a);
            this.check(a, K_NUMBER);
          }
        }
        return;
      case "TaggedTemplateExpression": {
        this.add(W_CALL);
        this.visitChildren(n);
        for (const e of (n.quasi as AnyNode).expressions as Node[]) this.check(e, K_NUMBER);
        return;
      }
      case "ObjectExpression":
        this.add(W_ALLOC);
        for (const p of n.properties as AnyNode[]) {
          if (p.type === "SpreadElement") {
            this.add(1);
            this.wrapCall(KEYS, p.argument as Node);
            this.visit(p.argument as Node);
          } else {
            this.visit(p);
          }
        }
        return;
      case "ArrayExpression":
        this.add(W_ALLOC);
        for (const e of n.elements as (Node | null)[]) {
          this.add(W_ELEMENT);
          if (e) this.visit(e);
        }
        return;
      case "VariableDeclarator":
        if (n.init && this.restAtTop(n.id as AnyNode)) this.wrapCall(KEYS, n.init as Node);
        this.visitPattern(n.id as Node, true);
        if (n.init) this.visit(n.init as Node);
        return;
      case "AssignmentExpression":
        this.visitAssignment(n);
        return;
      case "UpdateExpression":
        this.add(1);
        this.visitReadModifyWrite(n, n.argument as AnyNode);
        return;
      case "UnaryExpression":
        this.add(1);
        this.visit(n.argument as Node);
        if (n.operator === "+" || n.operator === "-" || n.operator === "~") {
          this.check(n.argument as Node, K_NUMBER);
        }
        return;
      case "ReturnStatement":
        this.add(1);
        // A returned string may go straight into a built-in (valueOf, a getter, a comparator).
        if (n.argument) {
          this.visit(n.argument as Node);
          if (!this.fn.callOnly) this.check(n.argument as Node, K_NUMBER);
        }
        return;
      case "YieldExpression":
        this.add(1);
        if (n.argument) {
          this.visit(n.argument as Node);
          if (!n.delegate) this.check(n.argument as Node, K_NUMBER);
        }
        return;
      case "ForStatement":
        this.visitFor(n);
        return;
      case "WhileStatement": {
        const test = this.measure(n.test as Node);
        this.add(test);
        this.charged([n.body as Node], bodyPlacement(n.body as AnyNode), test + W_ITERATION);
        return;
      }
      case "DoWhileStatement": {
        const test = this.measure(n.test as Node);
        this.charged([n.body as Node], bodyPlacement(n.body as AnyNode), test + W_ITERATION);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        if (n.type === "ForInStatement") this.wrapCall(FOR_IN, n.right as Node);
        this.visit(n.right as Node);
        // The head binds once per iteration, before the body's charge.
        const left = this.measureHead(n.left as AnyNode);
        this.add(left + W_ITERATION);
        this.charged([n.body as Node], bodyPlacement(n.body as AnyNode), left + W_ITERATION);
        // An exception in the body makes for-of call the iterator's return(), which is bot code
        // that can throw and drop further exceptions: charge it first (see LEAVING).
        if (n.type === "ForOfStatement") this.chargeBeforeClose(n);
        return;
      }
      case "IfStatement":
        this.add(1);
        this.visit(n.test as Node);
        this.branch([n.consequent as Node], bodyPlacement(n.consequent as AnyNode));
        if (n.alternate) {
          this.branch([n.alternate as Node], bodyPlacement(n.alternate as AnyNode));
        }
        return;
      case "SwitchStatement": {
        this.add(1);
        this.visit(n.discriminant as Node);
        // Each case compares with ===.
        const cases = n.cases as AnyNode[];
        this.check(n.discriminant as Node, K_EQUAL * Math.max(1, cases.length));
        for (const c of cases) {
          this.add(1);
          if (c.test) this.visit(c.test as Node);
          const body = c.consequent as Node[];
          this.markStatements(body);
          if (body.length > 0) this.branch(body, { kind: "before", pos: (body[0] as Node).start });
        }
        return;
      }
      case "TryStatement":
        this.visitTry(n);
        return;
      case "BlockStatement":
      case "StaticBlock":
        this.markStatements(n.body as Node[]);
        this.visitChildren(n);
        return;
      case "ExpressionStatement":
      case "EmptyStatement":
      case "VariableDeclaration":
      case "ChainExpression":
      case "ParenthesizedExpression":
        this.visitChildren(n);
        return;
      case "BinaryExpression":
        this.visitBinary(n);
        return;
      case "TemplateLiteral":
        this.add((n.expressions as Node[]).length > 0 ? W_TEMPLATE : 1);
        this.visitChildren(n);
        return;
      case "SpreadElement":
        // Arrays and calls spread through the iterator, which the prelude charges by length.
        this.add(2);
        this.visit(n.argument as Node);
        return;
      case "ObjectPattern":
      case "ArrayPattern":
      case "RestElement":
      case "AssignmentPattern":
        this.visitPattern(n, false);
        return;
      default:
        this.add(1);
        this.visitChildren(n);
    }
  }

  private visitFunction(n: AnyNode): void {
    this.add(W_CLOSURE);
    if (n.id) this.checkName((n.id as AnyNode).name as string, n.id as Node);
    const savedRegion = this.region;
    const savedFn = this.fn;
    const region: Region = { weight: 0 };
    this.region = region;
    this.fn = { nodes: 0, callOnly: this.types.callOnly(n) };

    // Parameters bind before the body's charge runs. Defaults get their own charge; the rest
    // is charged with the body, and if binding throws halfway, the catch that ends up with the
    // exception pays for the largest parameter list of the bundle (see `exception` in run()).
    let paramWeight = 0;
    for (const p of n.params as AnyNode[]) {
      const before = region.weight;
      this.visitParam(p);
      paramWeight += region.weight - before;
    }
    this.maxParamWeight = Math.max(this.maxParamWeight, paramWeight);

    const body = n.body as AnyNode;
    const leave = `}catch(${CAUGHT_VAR}){${LEAVING}(${CAUGHT_VAR});throw ${CAUGHT_VAR}}`;
    if (body.type === "BlockStatement") {
      this.markStatements(body.body as Node[]);
      for (const s of body.body as Node[]) this.visit(s);
      if (this.fn.temp) {
        this.edits.push({ pos: body.start + 1, text: `var ${TEMP};`, close: false, span: 0 });
      }
      if ((body.body as Node[]).length > 0) {
        const span = body.end - body.start;
        this.edits.push({ pos: body.start + 1, text: "try{", close: false, span: 0 });
        this.edits.push({ pos: body.end - 1, text: leave, close: true, span });
      }
      this.charges.push({ region, at: { kind: "block", pos: body.start + 1 } });
    } else {
      this.visit(body);
      if (!this.fn.callOnly) this.check(body, K_NUMBER);
      // `=> x` becomes `=> {try{return(x)}catch…}` (the parenthesis keeps a body that starts on
      // the next line from ending the `return` by ASI). With no space after `=>` (minified code)
      // the body starts right at the arrow, so the span is one more than any wrap of the body:
      // the `try` must stay outside the body's own checks and charge.
      const arrow = this.findArrow(n);
      const span = n.end - arrow + 1;
      this.edits.push({ pos: arrow, text: "{try{return(", close: false, span });
      this.edits.push({ pos: n.end, text: `)${leave}}`, close: true, span });
      this.charges.push({ region, at: { kind: "expression", node: body } });
    }
    this.endFunction(n);
    this.region = savedRegion;
    this.fn = savedFn;
  }

  private endFunction(node: Node): void {
    const { nodes } = this.fn;
    if (nodes > MAX_FUNCTION_NODES) {
      throw this.reject(
        node,
        `this function is too large for the sandbox (${nodes} syntax nodes, limit ${MAX_FUNCTION_NODES}): split it into smaller functions`,
      );
    }
    this.maxFunctionNodes = Math.max(this.maxFunctionNodes, nodes);
  }

  private visitParam(p: AnyNode): void {
    if (p.type === "AssignmentPattern") {
      this.add(1);
      this.visitParam(p.left as AnyNode);
      // Evaluated only when the argument is undefined; may call this very function again.
      this.charged([p.right as Node], { kind: "expression", node: p.right as Node });
      return;
    }
    if (p.type === "ObjectPattern" || p.type === "ArrayPattern" || p.type === "RestElement") {
      if (p.type === "ObjectPattern" && this.hasRest(p)) throw this.reject(p, OBJECT_REST_MESSAGE);
      this.visitPatternParts(p, (part) => this.visitParam(part));
      return;
    }
    this.visit(p);
  }

  /**
   * A pattern outside parameters: its defaults run inside the current region. Object rest copies
   * every key of its source, so it is only allowed where the source can be wrapped (`topOk`).
   */
  private visitPattern(p: Node, topOk: boolean): void {
    const n = p as AnyNode;
    if (n.type === "ObjectPattern") {
      if (!topOk && this.hasRest(n)) {
        throw this.reject(n, OBJECT_REST_MESSAGE);
      }
      this.visitPatternParts(n, (part) => this.visitPattern(part, false));
      return;
    }
    if (n.type === "ArrayPattern" || n.type === "RestElement") {
      this.visitPatternParts(n, (part) => this.visitPattern(part, false));
      return;
    }
    if (n.type === "AssignmentPattern") {
      this.add(1);
      this.visitPattern(n.left as Node, false);
      this.visit(n.right as Node);
      return;
    }
    // A member target may convert what it stores (`[a[i]] = xs` into a typed array, `.length`).
    if (n.type === "MemberExpression" && storesNumber(n)) this.viaAccessor(n);
    this.visit(n);
  }

  /** Visits the parts of a destructuring pattern; `part` handles nested targets. */
  private visitPatternParts(n: AnyNode, part: (p: AnyNode) => void): void {
    this.add(2);
    if (n.type === "ObjectPattern") {
      for (const prop of n.properties as AnyNode[]) {
        if (prop.type === "RestElement") {
          this.add(W_ALLOC);
          part(prop.argument as AnyNode);
          continue;
        }
        this.add(1);
        if (prop.computed) {
          this.visit(prop.key as Node);
          this.check(prop.key as Node, K_KEY);
        }
        part(prop.value as AnyNode);
      }
    } else if (n.type === "ArrayPattern") {
      for (const e of n.elements as (AnyNode | null)[]) {
        this.add(1);
        if (e) part(e);
      }
    } else {
      part(n.argument as AnyNode);
    }
  }

  private hasRest(n: AnyNode): boolean {
    return (n.properties as AnyNode[]).some((p) => p.type === "RestElement");
  }

  private restAtTop(n: AnyNode): boolean {
    return n.type === "ObjectPattern" && this.hasRest(n);
  }

  /** The head of a for-in/of: a declaration or an assignment target. */
  private measureHead(left: AnyNode): number {
    const saved = this.region;
    this.region = { weight: 0 };
    if (left.type === "VariableDeclaration") {
      for (const d of left.declarations as AnyNode[]) this.visitPattern(d.id as Node, false);
    } else {
      this.visitPattern(left, false);
    }
    const { weight } = this.region;
    this.region = saved;
    return weight;
  }

  private visitFor(n: AnyNode): void {
    if (n.init) this.visit(n.init as Node);
    const test = this.measure(n.test as Node);
    const update = this.measure(n.update as Node);
    // Per-iteration copies of `let` bindings.
    const init = n.init as AnyNode | null;
    const copies =
      init?.type === "VariableDeclaration" && init.kind !== "var"
        ? (init.declarations as Node[]).length
        : 0;
    this.add(test);
    this.charged(
      [n.body as Node],
      bodyPlacement(n.body as AnyNode),
      test + update + copies + W_ITERATION,
    );
  }

  private visitTry(n: AnyNode): void {
    this.add(1);
    const block = n.block as AnyNode;
    const handler = n.handler as AnyNode | null;
    const finalizer = n.finalizer as AnyNode | null;
    this.visit(block);
    if (handler) {
      const body = handler.body as AnyNode;
      const param = handler.param as AnyNode | null;
      let caught: string;
      if (!param) {
        // `catch {` → `catch(__zs_e){`
        this.edits.push({ pos: body.start, text: `(${CAUGHT_VAR})`, close: false, span: 0 });
        caught = CAUGHT_VAR;
      } else if (param.type === "Identifier") {
        this.checkName(param.name as string, param);
        caught = param.name as string;
      } else {
        // Binding a pattern could throw before the catch body's charge runs.
        throw this.reject(
          param,
          "destructuring in a catch clause is not supported: use `catch (e)` and destructure inside",
        );
      }
      this.markStatements(body.body as Node[]);
      this.charged(body.body as Node[], { kind: "block", pos: body.start + 1 }, 2, caught);
    }
    if (finalizer) this.visitFinally(n, finalizer);
  }

  /**
   * A `finally` runs once per entry of its region, so it is charged with that region. If it can
   * end abruptly (`return`, `break`, `continue`, `throw`), it can also swallow an exception that
   * no catch saw, so the try gets a catch that charges the exception and rethrows it.
   */
  private visitFinally(n: AnyNode, finalizer: AnyNode): void {
    this.visit(finalizer);
    if (!endsAbruptly(finalizer)) return;
    const block = n.block as AnyNode;
    const handler = n.handler as AnyNode | null;
    const rethrow = `catch(${CAUGHT_VAR}){${CAUGHT}(${CAUGHT_VAR});throw ${CAUGHT_VAR}}`;
    if (handler) {
      this.edits.push({ pos: block.start, text: "{try", close: false, span: 0 });
      this.edits.push({ pos: handler.end, text: `}${rethrow}`, close: true, span: 0 });
    } else {
      this.edits.push({ pos: block.end, text: rethrow, close: true, span: 0 });
    }
  }

  private visitClass(n: AnyNode): void {
    this.add(W_CLASS);
    if (n.id) this.checkName((n.id as AnyNode).name as string, n.id as Node);
    if (n.superClass) this.visit(n.superClass as Node);
    const body = n.body as AnyNode;
    // Instance fields are initialised on every construction, before the constructor body when
    // there is no superclass, so they get their own charge: a synthetic first private field.
    // QuickJS compiles them into one function, which counts toward the size limit.
    const fields: Region = { weight: 0 };
    const savedFn = this.fn;
    const fieldsFn: FunctionState = { nodes: 0 };
    let hasFields = false;
    for (const el of body.body as AnyNode[]) {
      this.add(2);
      if (el.computed) {
        this.visit(el.key as Node);
        this.check(el.key as Node, K_KEY, NEW_KEY);
      } else if (el.key && (el.key as AnyNode).type === "PrivateIdentifier") {
        this.checkName((el.key as AnyNode).name as string, el.key as Node);
      }
      if (el.type === "PropertyDefinition" && !el.static) {
        hasFields = true;
        const saved = this.region;
        this.region = fields;
        this.fn = fieldsFn;
        this.fn.nodes += 2;
        this.add(W_FIELD);
        if (el.value) this.visit(el.value as Node);
        this.region = saved;
        this.fn = savedFn;
      } else if (el.type === "StaticBlock") {
        this.markStatements(el.body as Node[]);
        for (const s of el.body as Node[]) this.visit(s);
      } else if (el.value) {
        // Methods, accessors and static field initialisers.
        this.visit(el.value as Node);
      }
    }
    if (hasFields) {
      this.fn = fieldsFn;
      this.endFunction(n);
      this.fn = savedFn;
      this.charges.push({ region: fields, at: { kind: "field", pos: body.start + 1 } });
    }
  }

  // ---- strings ----

  private visitBinary(n: AnyNode): void {
    const op = n.operator as string;
    const left = n.left as AnyNode;
    const right = n.right as AnyNode;
    this.add(op === "+" ? W_PLUS : 1);
    this.visit(left);
    this.visit(right);
    switch (op) {
      case "+":
        // Objects can convert to strings here, so both sides must be numeric to skip the cap.
        if (!this.types.numeric(left) || !this.types.numeric(right)) {
          this.addCheck();
          const span = n.end - n.start;
          this.fn.temp = true;
          this.edits.push({ pos: n.start, text: `(${TEMP}=`, close: false, span });
          this.edits.push({ pos: n.end, text: plusTail(false), close: true, span });
        }
        return;
      case "===":
      case "!==":
        // memcmp runs only when both are strings of the same length, so one side is enough.
        if (this.nonString(left) || this.nonString(right)) return;
        this.check(staticLength(right) !== undefined ? right : left, K_EQUAL);
        return;
      case "==":
      case "!=":
        if (isNull(left) || isNull(right)) return;
        this.check(left, K_NUMBER);
        this.check(right, K_NUMBER);
        return;
      case "in":
        if (left.type !== "PrivateIdentifier") this.check(left, K_KEY);
        return;
      case "instanceof":
        return;
      default:
        // Relational and arithmetic operators convert strings to numbers.
        this.check(left, K_NUMBER);
        this.check(right, K_NUMBER);
    }
  }

  private visitAssignment(n: AnyNode): void {
    const op = n.operator as string;
    const left = n.left as AnyNode;
    const right = n.right as Node;
    this.add(op === "+=" ? W_PLUS : 1);
    if (left.type === "ObjectPattern") {
      if (this.restAtTop(left)) this.wrapCall(KEYS, right);
      this.visitPattern(left, true);
      this.visit(right);
    } else if (left.type === "ArrayPattern") {
      this.visitPattern(left, false);
      this.visit(right);
    } else if (op === "=" || op === "&&=" || op === "||=" || op === "??=") {
      this.visit(left);
      this.visit(right);
      if (left.type === "MemberExpression" && storesNumber(left)) this.check(right, K_NUMBER);
    } else {
      this.visitReadModifyWrite(n, left);
    }
  }

  /**
   * `x++`, `x -= y`, `x += y`: the target's value is converted to a number (or concatenated),
   * so it is checked first. A name or a member of names (`a.b[i]`) is read twice for that;
   * any other member goes through the prelude's accessor (`__zs_w(obj, key).v`), which
   * evaluates the object and key once. `x += y` becomes `x = x + (y)`, so the cap applies
   * before the result is stored.
   */
  private visitReadModifyWrite(n: AnyNode, target: AnyNode): void {
    const simple = isSimple(target);
    if (!simple) this.viaAccessor(target);
    this.visit(target);
    const right = n.type === "AssignmentExpression" ? (n.right as AnyNode) : null;
    if (right) this.visit(right);
    if (
      this.types.numeric(target) &&
      (!right || n.operator !== "+=" || this.types.numeric(right))
    ) {
      if (right && n.operator !== "+=") this.check(right, K_NUMBER);
      return;
    }
    this.addCheck();
    if (!simple) return;
    const text = this.simpleText(target);
    if (n.operator === "+=" && right) {
      const op = this.findToken(target.end, "+=");
      const numeric = target.type === "MemberExpression" && storesNumber(target);
      const span = n.end - (op + 2);
      this.edits.push({ pos: op, text: "=", close: true, span: 0, del: 2 });
      this.fn.temp = true;
      this.edits.push({ pos: op + 2, text: `(${TEMP}=${text}+(`, close: false, span });
      this.edits.push({ pos: n.end, text: `)${plusTail(numeric)}`, close: true, span });
      return;
    }
    const span = n.end - n.start;
    this.edits.push({
      pos: n.start,
      text: `(typeof ${text}==="string"&&${chargeText(text, K_NUMBER)},`,
      close: false,
      span,
    });
    this.edits.push({ pos: n.end, text: ")", close: true, span });
    if (right) this.check(right, K_NUMBER);
  }

  /** `obj[key]` → `__zs_w(obj,key).v`, `obj.name` → `__zs_w(obj,"name").v`. */
  private viaAccessor(m: AnyNode): void {
    const object = m.object as AnyNode;
    const property = m.property as AnyNode;
    if (object.type === "Super" || property.type === "PrivateIdentifier") {
      throw this.reject(
        m,
        "this assignment target is not supported here: read it into a variable and assign it in a separate statement",
      );
    }
    const span = m.end - m.start;
    this.edits.push({ pos: m.start, text: `${MEMBER}(`, close: false, span });
    if (m.computed) {
      const open = this.findToken(object.end, "[");
      this.edits.push({ pos: open, text: ",", close: true, span: Infinity, del: 1 });
      const close = this.findToken(property.end, "]");
      this.edits.push({ pos: close, text: ").v", close: true, span, del: 1 });
    } else {
      const dot = this.findToken(object.end, ".");
      const name = JSON.stringify(property.name);
      this.edits.push({
        pos: dot,
        text: `,${name}).v`,
        close: true,
        span,
        del: property.end - dot,
      });
    }
  }

  /**
   * Charges a string operand by its length (`rate` units per char), or caps and charges it
   * through `helper`. Values that can't be strings are skipped and literals are charged
   * statically.
   */
  private check(node: Node, rate: number, helper?: string): void {
    const n = node as AnyNode;
    if (rate === K_KEY) {
      this.checkKey(n, helper);
      return;
    }
    if (this.nonString(n)) return;
    const length = staticLength(n);
    if (length !== undefined) {
      this.add(Math.ceil((length * rate) / UNITS_PER_WEIGHT));
      return;
    }
    this.addCheck();
    const tail = (v: string) => (helper ? `${helper}(${v})` : chargeText(v, rate));
    const span = n.end - n.start;
    if (n.type === "Identifier" || n.type === "ThisExpression") {
      // Reading a name twice has no side effects (a global getter would be a checked function).
      const v = n.type === "ThisExpression" ? "this" : this.source.slice(n.start, n.end);
      this.edits.push({
        pos: n.start,
        text: `(typeof ${v}==="string"&&${tail(v)},`,
        close: false,
        span,
      });
      this.edits.push({ pos: n.end, text: ")", close: true, span });
      return;
    }
    const seq = n.type === "SequenceExpression";
    this.fn.temp = true;
    this.edits.push({ pos: n.start, text: `(${TEMP}=${seq ? "(" : ""}`, close: false, span });
    this.edits.push({
      pos: n.end,
      text: `${seq ? ")" : ""},typeof ${TEMP}==="string"&&${tail(TEMP)},${TEMP})`,
      close: true,
      span,
    });
  }

  /**
   * A property key: a string is charged by length (or capped and charged through `helper`), an
   * int32 number passes, anything else goes through the prelude's `__zs_d`, which charges a
   * number's conversion by value and converts an object (once) to the key it yields.
   */
  private checkKey(n: AnyNode, helper?: string): void {
    if (n.type === "Literal" && typeof n.value === "number") {
      this.add(Math.ceil(literalKeyUnits(n.value) / UNITS_PER_WEIGHT));
      return;
    }
    const length = staticLength(n);
    if (length !== undefined) {
      this.add(Math.ceil((length * K_KEY) / UNITS_PER_WEIGHT));
      return;
    }
    if (n.type === "Literal" && !n.regex) return;
    this.addCheck();
    const span = n.end - n.start;
    if (OBJECT_EXPRESSIONS.has(n.type) || n.type === "Literal") {
      this.edits.push({ pos: n.start, text: `${KEY}(`, close: false, span });
      this.edits.push({ pos: n.end, text: ")", close: true, span });
      return;
    }
    const numeric = this.types.numeric(n);
    const tail = (v: string) => {
      const int = `(${v}|0)===${v}?${v}:${KEY}(`;
      if (numeric) return int;
      const str = helper ? `${helper}(${v})` : chargeText(v, K_KEY);
      return `typeof ${v}==="string"?(${str},${v}):typeof ${v}==="number"&&${int}`;
    };
    if (n.type === "Identifier" || n.type === "ThisExpression") {
      const v = n.type === "ThisExpression" ? "this" : this.source.slice(n.start, n.end);
      this.edits.push({ pos: n.start, text: `(${tail(v)}`, close: false, span });
      this.edits.push({ pos: n.end, text: "))", close: true, span });
      return;
    }
    const seq = n.type === "SequenceExpression";
    this.fn.temp = true;
    this.edits.push({ pos: n.start, text: `(${TEMP}=${seq ? "(" : ""}`, close: false, span });
    this.edits.push({
      pos: n.end,
      text: `${seq ? ")" : ""},${tail(TEMP)}${TEMP}))`,
      close: true,
      span,
    });
  }

  private checkLiteral(n: AnyNode): void {
    const regex = n.regex as { pattern: string; flags: string } | undefined;
    const length = regex ? regex.pattern.length : typeof n.value === "string" ? n.value.length : 0;
    if (length > MAX_STRING_LENGTH) {
      throw this.reject(
        n,
        `this literal is longer than ${MAX_STRING_LENGTH} chars, the longest string the sandbox allows: split it into an array of shorter strings`,
      );
    }
    if (!regex) return;
    this.regexUnits += regexCompileUnits(regex.pattern, regex.flags);
    if (this.regexUnits > MAX_REGEX_UNITS) {
      throw this.reject(
        n,
        "the regex literals of this bundle take too long to compile (case-insensitive classes and \\p{…} escapes are the costly parts): use fewer or shorter ones",
      );
    }
  }

  /** Source text for a node that {@link isSimple} accepts, without comments or line breaks. */
  private simpleText(n: AnyNode): string {
    switch (n.type) {
      case "ThisExpression":
        return "this";
      case "Super":
        return "super";
      case "Literal":
        return n.raw as string;
      case "MemberExpression": {
        const object = n.object as AnyNode;
        const prefix =
          object.type === "Literal" ? `(${this.simpleText(object)})` : this.simpleText(object);
        const property = n.property as AnyNode;
        if (n.computed) return `${prefix}[${this.simpleText(property)}]`;
        if (property.type === "PrivateIdentifier") return `${prefix}.#${property.name}`;
        return `${prefix}.${this.source.slice(property.start, property.end)}`;
      }
      default:
        return this.source.slice(n.start, n.end);
    }
  }

  /**
   * Wraps a for-of body in `try{…}catch(e){charge e; throw e}`. A head that destructures (or
   * stores into a member) can throw too, so it moves into that try: `for (const [a] of it) s` →
   * `for (const __zs_v of it) try{ const [a] = __zs_v; s }catch…`.
   */
  private chargeBeforeClose(n: AnyNode): void {
    const body = n.body as AnyNode;
    const head = n.left as AnyNode;
    const declared = head.type === "VariableDeclaration";
    const target = (declared ? (head.declarations as AnyNode[])[0]?.id : head) as AnyNode;
    const moves = target.type !== "Identifier";
    const block = body.type === "BlockStatement";
    if (!moves && block && (body.body as Node[]).length === 0) return;
    const start = block ? body.start + 1 : body.start;
    const end = block ? body.end - 1 : body.end;
    const span = end - start;
    // Opens at `start`: try, then the moved head, then (made later) the body's charge.
    this.edits.push({ pos: start, text: "try{", close: false, span: block ? 0 : span + 3 });
    if (moves) {
      const from = declared ? head.start : target.start;
      const kind = declared ? `${head.kind} ` : "";
      this.edits.push({
        pos: from,
        // The space keeps `const[a]of xs` (minified) from becoming `const __zs_vof xs`.
        text: `const ${HEAD} `,
        close: true,
        span: Infinity,
        del: head.end - from,
      });
      const assign = !declared && target.type === "ObjectPattern";
      this.edits.push({
        pos: start,
        text: "",
        close: false,
        span: block ? 0 : span + 2,
        move: {
          from: declared ? target.start : head.start,
          to: declared ? target.end : head.end,
          before: assign ? "(" : kind,
          after: assign ? `=${HEAD});` : `=${HEAD};`,
        },
      });
    }
    // In an empty block the end is the start: closing after every opening there.
    const empty = start === end;
    this.edits.push({
      pos: end,
      text: `}catch(${CAUGHT_VAR}){${CAUGHT}(${CAUGHT_VAR});throw ${CAUGHT_VAR}}`,
      close: !empty,
      span: empty ? -1 : span + 3,
    });
  }

  /** Position right after the `=>` of an arrow function. */
  private findArrow(n: AnyNode): number {
    const params = n.params as Node[];
    let i = params.length > 0 ? (params[params.length - 1] as Node).end : n.start;
    while (i < n.end && this.source[i] !== "=") {
      if (this.source.startsWith("/*", i)) i = this.source.indexOf("*/", i) + 2;
      else if (this.source.startsWith("//", i)) i = this.source.indexOf("\n", i);
      else i++;
    }
    if (!this.source.startsWith("=>", i))
      throw new Error(`instrument: expected "=>" at offset ${i}`);
    return i + 2;
  }

  /** Position of `token` after `from`, skipping whitespace, comments and closing parens. */
  private findToken(from: number, token: string): number {
    const src = this.source;
    let i = from;
    while (i < src.length) {
      if (src.startsWith(token, i)) return i;
      if (src.startsWith("//", i)) {
        const end = src.indexOf("\n", i);
        i = end < 0 ? src.length : end;
      } else if (src.startsWith("/*", i)) {
        i = src.indexOf("*/", i) + 2;
      } else if (src[i] === ")" || /\s/.test(src[i] ?? "")) {
        i++;
      } else {
        break;
      }
    }
    throw new Error(`instrument: expected "${token}" at offset ${i}`);
  }

  /** Never a string primitive: numeric, or an object (objects convert through checked code). */
  private nonString(n: AnyNode): boolean {
    return this.types.numeric(n) || OBJECT_EXPRESSIONS.has(n.type);
  }

  private markStatements(list: Node[]): void {
    for (const stmt of list)
      if (stmt.type === "ExpressionStatement") this.statementStarts.add(stmt.start);
  }

  // ---- edits ----

  /** `expr` → `helper(expr)`; `a, b` → `helper((a, b))`. */
  private wrapCall(helper: string, expr: Node): void {
    const span = expr.end - expr.start;
    const sequence = expr.type === "SequenceExpression";
    this.edits.push({
      pos: expr.start,
      text: sequence ? `${helper}((` : `${helper}(`,
      close: false,
      span,
    });
    this.edits.push({ pos: expr.end, text: sequence ? "))" : ")", close: true, span });
  }

  private place(c: Charge): void {
    const units = Math.ceil(c.region.weight * UNITS_PER_WEIGHT);
    const caught = c.caught === undefined ? "" : `${CAUGHT}(${c.caught});`;
    const at = c.at;
    switch (at.kind) {
      case "block":
      case "before":
        this.edits.push({
          pos: at.pos,
          text: caught + chargeStatement(units),
          close: false,
          span: 0,
        });
        return;
      case "statement": {
        // One more than the statement: around the wraps of its expression, which may end at
        // the same place (`for(;;)a.b++` with no semicolon).
        const span = at.node.end - at.node.start + 1;
        this.edits.push({
          pos: at.node.start,
          text: `{${chargeStatement(units)}`,
          close: false,
          span,
        });
        this.edits.push({ pos: at.node.end, text: "}", close: true, span });
        return;
      }
      case "expression": {
        const span = at.node.end - at.node.start;
        this.edits.push({
          pos: at.node.start,
          text: `(${chargeExpression(units)},`,
          close: false,
          span,
        });
        this.edits.push({ pos: at.node.end, text: ")", close: true, span });
        return;
      }
      case "field":
        this.edits.push({
          pos: at.pos,
          text: `#${RESERVED}=${chargeExpression(units)};`,
          close: false,
          span: 0,
        });
        return;
    }
  }

  /**
   * Applies the edits. At one position: closings before openings; closings inner (smaller span)
   * first; openings outer (larger span, span 0 above any finite one) first; otherwise openings
   * in the order they were made and closings in reverse (the first wrap made around a node is
   * the outermost). An opening `(` at the start of an expression statement gets a `;` first
   * (see `statementStarts`).
   *
   * Minified code puts many of these at one position: `{a.b++` has the function's `try{` and
   * charge and the update's wrap all right after the `{` (re-verification of #62).
   */
  private apply(): string {
    const order = this.edits.map((e, i) => ({ e, i }));
    const outer = (e: Edit) => (e.span === 0 && !e.close ? Number.MAX_VALUE : e.span);
    order.sort((a, b) => {
      if (a.e.pos !== b.e.pos) return a.e.pos - b.e.pos;
      if (a.e.close !== b.e.close) return a.e.close ? -1 : 1;
      const sa = outer(a.e);
      const sb = outer(b.e);
      if (sa !== sb) return a.e.close ? sa - sb : sb - sa;
      return a.e.close ? b.i - a.i : a.i - b.i;
    });
    const edits = order.map(({ e }) => e);
    // Edits inside a moved range go with it.
    const moved = new Set<Edit>();
    for (const m of edits) {
      if (!m.move) continue;
      const { from, to } = m.move;
      for (const e of edits) {
        if (e.pos > from && e.pos < to) moved.add(e);
        else if (e.pos === from && !e.close) moved.add(e);
        else if (e.pos === to && e.close && !e.del) moved.add(e);
      }
    }
    const main = edits.filter((e) => !moved.has(e));
    return this.render(main, 0, this.source.length, edits);
  }

  /** The source from `from` to `to` with `list` applied (sorted, all inside the range). */
  private render(list: Edit[], from: number, to: number, all: Edit[]): string {
    let out = "";
    let last = from;
    let guarded = -1;
    for (const e of list) {
      if (e.pos > last) {
        out += this.source.slice(last, e.pos);
        last = e.pos;
      }
      if (
        !e.close &&
        e.text.startsWith("(") &&
        guarded !== e.pos &&
        this.statementStarts.has(e.pos)
      ) {
        out += ";";
        guarded = e.pos;
      }
      if (e.move) {
        const { from: a, to: b, before, after } = e.move;
        const inner = all.filter(
          (x) =>
            x !== e &&
            ((x.pos > a && x.pos < b) ||
              (x.pos === a && !x.close) ||
              (x.pos === b && x.close && !x.del)),
        );
        const text = this.render(inner, a, b, all).replace(/\n/g, " ");
        out += before + text + after;
      }
      out += e.text;
      if (e.del) {
        out += this.source.slice(e.pos, e.pos + e.del).replace(/[^\n]/g, "");
        last = e.pos + e.del;
      }
    }
    return out + this.source.slice(last, to);
  }

  // ---- checks ----

  private checkName(name: string, node: Node): void {
    if (name.length > MAX_STRING_LENGTH) {
      throw this.reject(node, `this name is longer than ${MAX_STRING_LENGTH} chars`);
    }
    if (name.startsWith(RESERVED)) {
      throw this.reject(
        node,
        `identifiers starting with "${RESERVED}" are reserved for the sandbox (found "${name}")`,
      );
    }
  }

  private reject(node: Node, message: string): Rejected {
    return new Rejected(`${message} (line ${lineOf(this.source, node.start)})`);
  }
}

const OBJECT_REST_MESSAGE =
  "object rest (`{ a, ...rest }`) is only supported as `const { a, ...rest } = value` or `({ a, ...rest } = value)`; destructure in a separate statement";

/** Charges `v.length * rate` units: `v` is a string here. */
function chargeText(v: string, rate: number): string {
  return `(${COUNTER}-=${v}.length*${rate})<0&&${OVERRUN}()`;
}

/**
 * The end of `(__zs_t=a+b` …: a string result goes through the prelude (`__zs_n`), which caps
 * it and charges a slow number conversion it finds in it. `numeric`: the result is stored where
 * a string becomes a number (`a[i] += s`), so it is charged for that too.
 */
function plusTail(numeric: boolean): string {
  const cap = `${NEW_STRING}(${TEMP})`;
  const check = numeric ? `(${cap},${chargeText(TEMP, K_NUMBER)})` : cap;
  return `,typeof ${TEMP}==="string"&&${check},${TEMP})`;
}

/** What compiling a regex costs (see `REGEX_CHAR_UNITS`). Over-estimates on purpose. */
function regexCompileUnits(pattern: string, flags: string): number {
  const n = pattern.length;
  let units = n * REGEX_CHAR_UNITS;
  if (flags.includes("i")) units += n * REGEX_FOLD_UNITS;
  if (flags.includes("u") || flags.includes("v")) {
    const escapes = pattern.match(/\\[pP]\{/g)?.length ?? 0;
    units += escapes * (flags.includes("v") ? REGEX_PROPERTY_V_UNITS : REGEX_PROPERTY_UNITS);
  }
  return units;
}

/** What converting a number literal used as a key costs (see `dtoaCost` in prelude.ts). */
function literalKeyUnits(v: number): number {
  if (v === (v | 0)) return 0;
  const a = Math.abs(v);
  return (a >= 1e100 && a !== Number.POSITIVE_INFINITY) || (a < 1e-99 && a !== 0)
    ? DTOA_MAX_UNITS
    : DTOA_UNITS;
}

/** Whether a store to this member may convert the value to a number (typed array, length). */
function storesNumber(m: AnyNode): boolean {
  const p = m.property as AnyNode;
  return m.computed === true || (p.type === "Identifier" && p.name === "length");
}

/**
 * Whether an expression can be read again without side effects (except getters, whose results
 * are checked anyway): names, `this`, literals and non-optional members of those.
 */
function isSimple(n: AnyNode): boolean {
  switch (n.type) {
    case "Identifier":
    case "ThisExpression":
      return true;
    case "Literal":
      return !/[\n\r\u2028\u2029]/.test(n.raw as string);
    case "MemberExpression": {
      if (n.optional) return false;
      const object = n.object as AnyNode;
      if (object.type !== "Super" && !isSimple(object)) return false;
      return !n.computed || isSimple(n.property as AnyNode);
    }
    default:
      return false;
  }
}

/** Expressions that evaluate to an object. */
const OBJECT_EXPRESSIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "ClassExpression",
  "ObjectExpression",
  "ArrayExpression",
  "NewExpression",
]);

/** Length of a string literal or a template without substitutions. */
function staticLength(n: AnyNode): number | undefined {
  if (n.type === "Literal") return typeof n.value === "string" ? n.value.length : undefined;
  if (n.type === "TemplateLiteral" && (n.expressions as Node[]).length === 0) {
    const q = (n.quasis as AnyNode[])[0]?.value as { cooked: string | null } | undefined;
    return q?.cooked?.length ?? 0;
  }
  return undefined;
}

function isNull(n: AnyNode): boolean {
  return n.type === "Literal" && n.value === null && !n.regex;
}

function chargeStatement(units: number): string {
  return `if((${COUNTER}-=${units})<0)${OVERRUN}();`;
}

function chargeExpression(units: number): string {
  return `(${COUNTER}-=${units})<0&&${OVERRUN}()`;
}

function bodyPlacement(body: AnyNode): Placement {
  return body.type === "BlockStatement"
    ? { kind: "block", pos: body.start + 1 }
    : { kind: "statement", node: body };
}

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as Node).type === "string";
}

/** Whether a `finally` block contains return/break/continue/throw outside nested functions. */
function endsAbruptly(node: AnyNode): boolean {
  switch (node.type) {
    case "ReturnStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ThrowStatement":
      return true;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return false;
  }
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c) && endsAbruptly(c as AnyNode)) return true;
    } else if (isNode(v) && endsAbruptly(v as AnyNode)) {
      return true;
    }
  }
  return false;
}

/**
 * Rejects brackets nested deeper than {@link MAX_NESTING}, so the recursive parser never runs
 * out of stack (where it does would depend on the engine and its state). Counts `([{` loosely,
 * also inside strings and comments: a false positive only rejects an absurd bundle.
 */
function checkNesting(source: string): string | null {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) {
      if (++depth > MAX_NESTING) {
        return `brackets are nested more than ${MAX_NESTING} deep (line ${lineOf(source, i)})`;
      }
    } else if (c === 41 || c === 93 || c === 125) {
      if (depth > 0) depth--;
    }
  }
  return null;
}

/** Rejects more than {@link MAX_PROPERTY_ESCAPES}, counted loosely (also in strings). */
function checkPropertyEscapes(source: string): string | null {
  let count = 0;
  for (let i = source.indexOf("\\"); i >= 0; i = source.indexOf("\\", i + 1)) {
    const c = source[i + 1];
    if ((c === "p" || c === "P") && source[i + 2] === "{" && ++count > MAX_PROPERTY_ESCAPES) {
      return `more than ${MAX_PROPERTY_ESCAPES} \\p{…} escapes in the bundle (line ${lineOf(source, i)}): they are slow to check`;
    }
  }
  return null;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}
