import { type Node, parse } from "acorn";
import { checkSource } from "./source.ts";

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
  const problem = checkSource(source) ?? checkNesting(source);
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
  /** Size of the wrapped range: at one position, outer opens first and inner closes first. */
  span: number;
}

interface FunctionState {
  /** Syntax nodes of this function's own code (nested functions excluded). */
  nodes: number;
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

  constructor(source: string) {
    this.source = source;
  }

  run(ast: Node): InstrumentResult {
    const top = this.region;
    const module = this.fn;
    for (const stmt of (ast as AnyNode).body as Node[]) this.visit(stmt);

    for (const c of this.charges) this.place(c);
    const tick =
      BACKTRACE_UNITS_PER_CHAR + BACKTRACE_UNITS_PER_CHAR_PER_NODE * this.maxFunctionNodes;
    const load =
      BACKTRACE_UNITS_PER_CHAR +
      BACKTRACE_UNITS_PER_CHAR_PER_NODE * Math.max(this.maxFunctionNodes, module.nodes);
    const exception = EXCEPTION_UNITS + this.maxParamWeight * UNITS_PER_WEIGHT;
    const header =
      `var ${COUNTER}=0;const{o:${OVERRUN},k:${KEYS},f:${FOR_IN},x:${CAUGHT}}=` +
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
        this.add(n.regex ? W_REGEX : 1);
        return;
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
        if (n.computed) this.visit(n.property as Node);
        return;
      case "Property":
        this.add(W_PROPERTY);
        if (n.computed) this.visit(n.key as Node);
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
      case "TaggedTemplateExpression":
        this.add(n.type === "NewExpression" ? W_NEW : W_CALL);
        this.visitChildren(n);
        return;
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
        this.add(n.operator === "+=" ? W_PLUS : 1);
        if (n.left && (n.left as AnyNode).type === "ObjectPattern") {
          if (this.restAtTop(n.left as AnyNode)) this.wrapCall(KEYS, n.right as Node);
          this.visitPattern(n.left as Node, true);
        } else if ((n.left as AnyNode).type === "ArrayPattern") {
          this.visitPattern(n.left as Node, false);
        } else {
          this.visit(n.left as Node);
        }
        this.visit(n.right as Node);
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
      case "SwitchStatement":
        this.add(1);
        this.visit(n.discriminant as Node);
        for (const c of n.cases as AnyNode[]) {
          this.add(1);
          if (c.test) this.visit(c.test as Node);
          const body = c.consequent as Node[];
          if (body.length > 0) this.branch(body, { kind: "before", pos: (body[0] as Node).start });
        }
        return;
      case "TryStatement":
        this.visitTry(n);
        return;
      case "BlockStatement":
      case "ExpressionStatement":
      case "EmptyStatement":
      case "VariableDeclaration":
      case "ChainExpression":
      case "ParenthesizedExpression":
      case "StaticBlock":
        this.visitChildren(n);
        return;
      case "BinaryExpression":
        this.add(n.operator === "+" ? W_PLUS : 1);
        this.visitChildren(n);
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
    this.fn = { nodes: 0 };

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
    if (body.type === "BlockStatement") {
      for (const s of body.body as Node[]) this.visit(s);
      this.charges.push({ region, at: { kind: "block", pos: body.start + 1 } });
    } else {
      this.visit(body);
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
        if (prop.computed) this.visit(prop.key as Node);
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
      if (el.computed) this.visit(el.key as Node);
      else if (el.key && (el.key as AnyNode).type === "PrivateIdentifier") {
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
        const span = at.node.end - at.node.start;
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
   * first; openings outer (larger span) first; otherwise in the order they were made.
   */
  private apply(): string {
    const order = this.edits.map((e, i) => ({ e, i }));
    order.sort((a, b) => {
      if (a.e.pos !== b.e.pos) return a.e.pos - b.e.pos;
      if (a.e.close !== b.e.close) return a.e.close ? -1 : 1;
      if (a.e.span !== b.e.span) return a.e.close ? a.e.span - b.e.span : b.e.span - a.e.span;
      return a.i - b.i;
    });
    let out = "";
    let last = 0;
    for (const { e } of order) {
      out += this.source.slice(last, e.pos) + e.text;
      last = e.pos;
    }
    return out + this.source.slice(last);
  }

  // ---- checks ----

  private checkName(name: string, node: Node): void {
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

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}
