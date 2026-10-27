import type { Node } from "acorn";

/**
 * Which variables of a bundle can only ever hold numbers (or booleans, null, undefined), so the
 * instrumentation can skip the string checks on them (see `instrument.ts`): a check costs about
 * as much as the arithmetic it guards, and most operands in a bot's hot loops are such locals
 * (`const dx = p.x - head.x`, loop counters, running minimums).
 *
 * A binding is "numeric" when it is not a parameter, a destructuring or for-in/of target, a
 * catch parameter, a function or a class, and every value ever written to it is numeric:
 * literals, arithmetic, comparisons, `Math.*()` calls (the prelude freezes `Math`), other numeric
 * bindings. The analysis resolves names with the module's real scoping rules (strict mode: block
 * scoped functions, hoisted `var`), and has no way out: bot code has no `eval` or `with`, and
 * nothing outside the module can write its bindings. Names it can't resolve are globals, which bot
 * code can set to anything, except the read-only `undefined`, `NaN` and `Infinity`.
 *
 * It also finds the bot's own functions: a name bound only to a function declaration or a
 * function expression. Arguments passed to one by name reach bot code, which checks what it does
 * with them; and if the name is only ever called (never read as a value, so the function can't
 * become a getter, a valueOf or a callback of a built-in), its return values only reach bot code
 * too.
 */
export class Types {
  private readonly refs = new Map<Node, Binding>();
  /** Function node → the binding that may name it. */
  private readonly functions = new Map<Node, Binding>();

  constructor(program: Node) {
    const bindings: Binding[] = [];
    new Resolver(this.refs, bindings).program(program as AnyNode);
    for (const b of bindings) {
      // Only a declaration, or exactly one write of a function expression.
      const only =
        b.writes.length === 0
          ? b.declared
          : b.writes.length === 1 && !b.declared
            ? b.writes[0]
            : undefined;
      if (!b.opaque && only !== undefined && ownCode(only)) {
        b.fn = only;
        this.functions.set(only, b);
      }
    }
    // Greatest fixpoint: start from "numeric" and drop bindings with a non-numeric write until
    // nothing changes (so `a = b; b = a` with numeric starts stays numeric).
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of bindings) {
        if (b.numeric && b.writes.some((w) => !this.numeric(w))) {
          b.numeric = false;
          changed = true;
        }
      }
    }
  }

  /** Whether calling `callee` (a name) always runs one of the bot's own functions. */
  ownFunction(callee: AnyNode): boolean {
    if (callee.type !== "Identifier") return false;
    const b = this.refs.get(callee);
    return b !== undefined && b.fn !== undefined;
  }

  /** Whether a function's return values can only reach bot code (see the class comment). */
  callOnly(fn: Node): boolean {
    const b = this.functions.get(fn);
    return b !== undefined && b.fn === fn && !b.escapes;
  }

  /** Whether `n` always evaluates to a number, boolean, null or undefined. */
  numeric(n: AnyNode): boolean {
    switch (n.type) {
      case "Literal":
        return (
          typeof n.value === "number" ||
          typeof n.value === "boolean" ||
          (n.value === null && !n.regex)
        );
      case "Identifier": {
        const b = this.refs.get(n);
        return b ? b.numeric : READ_ONLY_GLOBALS.has(n.name as string);
      }
      case "UnaryExpression":
        return n.operator !== "typeof";
      case "UpdateExpression":
        return true;
      case "BinaryExpression":
        return (
          n.operator !== "+" ||
          (this.numeric(n.left as AnyNode) && this.numeric(n.right as AnyNode))
        );
      case "LogicalExpression":
        return this.numeric(n.left as AnyNode) && this.numeric(n.right as AnyNode);
      case "ConditionalExpression":
        return this.numeric(n.consequent as AnyNode) && this.numeric(n.alternate as AnyNode);
      case "SequenceExpression": {
        const list = n.expressions as AnyNode[];
        return this.numeric(list[list.length - 1] as AnyNode);
      }
      case "AssignmentExpression": {
        const op = n.operator as string;
        if (op === "=") return this.numeric(n.right as AnyNode);
        if (op === "+=" || op === "&&=" || op === "||=" || op === "??=") {
          return this.numeric(n.left as AnyNode) && this.numeric(n.right as AnyNode);
        }
        return true;
      }
      case "CallExpression": {
        // Math.f(...): the prelude makes the global Math and its methods read-only.
        const callee = n.callee as AnyNode;
        if (callee.type !== "MemberExpression" || callee.computed || n.optional) return false;
        const object = callee.object as AnyNode;
        return object.type === "Identifier" && object.name === "Math" && !this.refs.has(object);
      }
      default:
        return false;
    }
  }
}

type AnyNode = Node & Record<string, unknown>;

/** Globals bot code can't change (non-writable, non-configurable). */
const READ_ONLY_GLOBALS = new Set(["undefined", "NaN", "Infinity"]);

interface Binding {
  numeric: boolean;
  /** Every value written to it (initializer, assignments). */
  writes: AnyNode[];
  /** Also written with values we don't track (a parameter, a pattern, a for-in/of head). */
  opaque?: boolean;
  /** The function or class declaration that binds it. */
  declared?: AnyNode;
  /** Read other than as the callee of a call. */
  escapes?: boolean;
  /** Set when it always holds this bot function (see Types). */
  fn?: AnyNode;
}

/**
 * A function, or a class whose constructor is its own code: a derived class without one passes
 * its arguments straight to the parent, which may be a built-in (`class N extends Number {}`).
 */
function ownCode(n: AnyNode): boolean {
  if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") return true;
  if (n.type === "ArrowFunctionExpression") return true;
  if (n.type !== "ClassDeclaration" && n.type !== "ClassExpression") return false;
  return (
    !n.superClass || ((n.body as AnyNode).body as AnyNode[]).some((el) => el.kind === "constructor")
  );
}

/** Placeholder for a write that is always numeric (`x++`, `x -= y`, a `let` without a value). */
const NUMBER: AnyNode = { type: "Literal", value: 0, start: 0, end: 0 } as unknown as AnyNode;

class Scope {
  readonly names = new Map<string, Binding>();
  readonly parent: Scope | null;

  constructor(parent: Scope | null) {
    this.parent = parent;
  }

  lookup(name: string): Binding | undefined {
    for (let s: Scope | null = this; s; s = s.parent) {
      const b = s.names.get(name);
      if (b) return b;
    }
    return undefined;
  }
}

/**
 * Two steps per scope, like the language: declare everything the scope holds (hoisting), then
 * walk its code and resolve each name read or written. Names in other positions (property keys,
 * labels, member names) are skipped.
 */
class Resolver {
  private scope: Scope = new Scope(null);
  private readonly refs: Map<Node, Binding>;
  private readonly bindings: Binding[];

  constructor(refs: Map<Node, Binding>, bindings: Binding[]) {
    this.refs = refs;
    this.bindings = bindings;
  }

  program(n: AnyNode): void {
    this.declareVars(n.body as AnyNode[], this.scope);
    this.declareLexical(n.body as AnyNode[], this.scope);
    for (const s of n.body as AnyNode[]) this.walk(s);
  }

  // ---- declarations ----

  private bind(scope: Scope, name: string, numeric: boolean): Binding {
    let b = scope.names.get(name);
    if (!b) {
      b = { numeric, writes: [] };
      scope.names.set(name, b);
      this.bindings.push(b);
    } else if (!numeric) {
      b.numeric = false;
    }
    return b;
  }

  /** Binds every name in a pattern as unknown (parameters, destructuring, catch). */
  private bindPattern(scope: Scope, p: AnyNode | null): void {
    if (!p) return;
    for (const id of patternNames(p)) this.bind(scope, id, false).opaque = true;
  }

  /** `var` declarations anywhere in `body`, not inside nested functions or classes. */
  private declareVars(body: AnyNode[], scope: Scope): void {
    const visit = (n: AnyNode | null | undefined): void => {
      if (!n || typeof n !== "object") return;
      switch (n.type) {
        case "VariableDeclaration":
          if (n.kind === "var") {
            for (const d of n.declarations as AnyNode[]) {
              const id = d.id as AnyNode;
              if (id.type === "Identifier") this.bind(scope, id.name as string, true);
              else this.bindPattern(scope, id);
            }
          }
          return;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
        case "ClassDeclaration":
        case "ClassExpression":
          return;
      }
      if (!isStatement(n)) return;
      for (const key of Object.keys(n)) {
        const v = n[key];
        if (Array.isArray(v)) for (const c of v) visit(c as AnyNode);
        else if (v && typeof v === "object" && typeof (v as AnyNode).type === "string")
          visit(v as AnyNode);
      }
    };
    for (const s of body) visit(s);
  }

  /** `let`, `const`, `class` and (block-scoped in strict code) function declarations of a list. */
  private declareLexical(list: AnyNode[], scope: Scope): void {
    for (let s of list) {
      if (s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration") {
        s = (s.declaration as AnyNode | null) ?? s;
      }
      if (s.type === "VariableDeclaration" && s.kind !== "var") {
        for (const d of s.declarations as AnyNode[]) {
          const id = d.id as AnyNode;
          if (id.type === "Identifier") this.bind(scope, id.name as string, true);
          else this.bindPattern(scope, id);
        }
      } else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) {
        const b = this.bind(scope, (s.id as AnyNode).name as string, false);
        if (b.declared) b.opaque = true;
        b.declared = s;
      }
    }
  }

  // ---- walking ----

  private inScope<T>(scope: Scope, f: () => T): T {
    const saved = this.scope;
    this.scope = scope;
    try {
      return f();
    } finally {
      this.scope = saved;
    }
  }

  private block(list: AnyNode[]): void {
    const scope = new Scope(this.scope);
    this.declareLexical(list, scope);
    this.inScope(scope, () => {
      for (const s of list) this.walk(s);
    });
  }

  /** A name read as a value (`escapes`) or written (`escapes: false`). */
  private ref(id: AnyNode, escapes = true): Binding | undefined {
    const b = this.scope.lookup(id.name as string);
    if (b) {
      this.refs.set(id, b);
      if (escapes) b.escapes = true;
    }
    return b;
  }

  /** A write of `value` to a target (an assignment's left side or a pattern). */
  private write(target: AnyNode, value: AnyNode | null): void {
    if (target.type === "Identifier") {
      const b = this.ref(target, false);
      if (b) {
        if (value) b.writes.push(value);
        else {
          b.numeric = false;
          b.opaque = true;
        }
      }
      return;
    }
    if (target.type === "MemberExpression") {
      this.walk(target);
      return;
    }
    // A pattern: every name in it gets an unknown value; defaults and computed keys are code.
    this.patternTargets(target);
  }

  private patternTargets(p: AnyNode): void {
    switch (p.type) {
      case "Identifier":
        this.write(p, null);
        return;
      case "MemberExpression":
        this.walk(p);
        return;
      case "ObjectPattern":
        for (const prop of p.properties as AnyNode[]) {
          if (prop.type === "RestElement") {
            this.patternTargets(prop.argument as AnyNode);
          } else {
            if (prop.computed) this.walk(prop.key as AnyNode);
            this.patternTargets(prop.value as AnyNode);
          }
        }
        return;
      case "ArrayPattern":
        for (const e of p.elements as (AnyNode | null)[]) if (e) this.patternTargets(e);
        return;
      case "RestElement":
        this.patternTargets(p.argument as AnyNode);
        return;
      case "AssignmentPattern":
        this.patternTargets(p.left as AnyNode);
        this.walk(p.right as AnyNode);
        return;
    }
  }

  private fn(n: AnyNode): void {
    let outer = this.scope;
    if (n.type === "FunctionExpression" && n.id) {
      // A named function expression sees its own name.
      outer = new Scope(outer);
      this.bind(outer, (n.id as AnyNode).name as string, false);
    }
    // Parameters get their own scope: code in a default can't see the body's declarations.
    const params = new Scope(outer);
    for (const p of n.params as AnyNode[]) this.bindPattern(params, p);
    const scope = new Scope(params);
    const body = n.body as AnyNode;
    if (body.type === "BlockStatement") {
      this.declareVars(body.body as AnyNode[], scope);
      this.declareLexical(body.body as AnyNode[], scope);
      // `var x` with a parameter's name starts with the argument's value.
      for (const [name, b] of scope.names) if (params.names.has(name)) b.numeric = false;
    }
    this.inScope(params, () => {
      for (const p of n.params as AnyNode[]) this.paramCode(p);
    });
    this.inScope(scope, () => {
      if (body.type === "BlockStatement") for (const s of body.body as AnyNode[]) this.walk(s);
      else this.walk(body);
    });
  }

  /** Defaults and computed keys inside a parameter pattern (its names are already bound). */
  private paramCode(p: AnyNode): void {
    switch (p.type) {
      case "AssignmentPattern":
        this.paramCode(p.left as AnyNode);
        this.walk(p.right as AnyNode);
        return;
      case "ObjectPattern":
        for (const prop of p.properties as AnyNode[]) {
          if (prop.type === "RestElement") this.paramCode(prop.argument as AnyNode);
          else {
            if (prop.computed) this.walk(prop.key as AnyNode);
            this.paramCode(prop.value as AnyNode);
          }
        }
        return;
      case "ArrayPattern":
        for (const e of p.elements as (AnyNode | null)[]) if (e) this.paramCode(e);
        return;
      case "RestElement":
        this.paramCode(p.argument as AnyNode);
        return;
      case "Identifier":
        this.ref(p);
        return;
    }
  }

  private cls(n: AnyNode): void {
    if (n.superClass) this.walk(n.superClass as AnyNode);
    const scope = new Scope(this.scope);
    if (n.id) this.bind(scope, (n.id as AnyNode).name as string, false);
    this.inScope(scope, () => {
      for (const el of (n.body as AnyNode).body as AnyNode[]) {
        if (el.computed) this.walk(el.key as AnyNode);
        if (el.type === "StaticBlock") {
          const body = el.body as AnyNode[];
          const s = new Scope(this.scope);
          this.declareVars(body, s);
          this.declareLexical(body, s);
          this.inScope(s, () => {
            for (const st of body) this.walk(st);
          });
        } else if (el.value) {
          this.walk(el.value as AnyNode);
        }
      }
    });
  }

  private walk(n: AnyNode | null | undefined): void {
    if (!n) return;
    switch (n.type) {
      case "Identifier":
        this.ref(n);
        return;
      case "VariableDeclaration":
        for (const d of n.declarations as AnyNode[]) {
          const id = d.id as AnyNode;
          if (id.type === "Identifier") {
            const b = this.ref(id, false);
            // `let x;` is undefined; `var x;` writes nothing (it may repeat an earlier `var x`).
            if (b && (d.init || n.kind !== "var"))
              b.writes.push((d.init as AnyNode | null) ?? NUMBER);
          } else {
            this.patternTargets(id);
          }
          this.walk(d.init as AnyNode | null);
        }
        return;
      case "AssignmentExpression": {
        const op = n.operator as string;
        const left = n.left as AnyNode;
        this.walk(n.right as AnyNode);
        if (left.type !== "Identifier") {
          this.write(left, null);
          return;
        }
        if (op === "=") this.write(left, n.right as AnyNode);
        else if (op === "+=" || op === "&&=" || op === "||=" || op === "??=") this.write(left, n);
        else this.write(left, NUMBER);
        return;
      }
      case "UpdateExpression": {
        const arg = n.argument as AnyNode;
        if (arg.type === "Identifier") this.write(arg, NUMBER);
        else this.walk(arg);
        return;
      }
      case "CallExpression":
      case "NewExpression": {
        // Calling a name doesn't let the function escape.
        const callee = n.callee as AnyNode;
        if (callee.type === "Identifier") this.ref(callee, false);
        else this.walk(callee);
        for (const a of n.arguments as AnyNode[]) this.walk(a);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.fn(n);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        this.cls(n);
        return;
      case "BlockStatement":
        this.block(n.body as AnyNode[]);
        return;
      case "StaticBlock":
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const head = (n.type === "ForStatement" ? n.init : n.left) as AnyNode | null;
        const scope = new Scope(this.scope);
        if (head?.type === "VariableDeclaration" && head.kind !== "var") {
          this.declareLexical([head], scope);
        }
        this.inScope(scope, () => {
          if (n.type === "ForStatement") {
            this.walk(n.init as AnyNode | null);
            this.walk(n.test as AnyNode | null);
            this.walk(n.update as AnyNode | null);
          } else {
            this.walk(n.right as AnyNode);
            // for-in yields strings, for-of anything.
            if (head?.type === "VariableDeclaration") {
              for (const d of head.declarations as AnyNode[]) this.patternTargets(d.id as AnyNode);
            } else if (head) {
              this.patternTargets(head);
            }
          }
          this.walk(n.body as AnyNode);
        });
        return;
      }
      case "SwitchStatement": {
        this.walk(n.discriminant as AnyNode);
        const cases = n.cases as AnyNode[];
        const scope = new Scope(this.scope);
        this.declareLexical(
          cases.flatMap((c) => c.consequent as AnyNode[]),
          scope,
        );
        this.inScope(scope, () => {
          for (const c of cases) {
            this.walk(c.test as AnyNode | null);
            for (const s of c.consequent as AnyNode[]) this.walk(s);
          }
        });
        return;
      }
      case "CatchClause": {
        const scope = new Scope(this.scope);
        this.bindPattern(scope, n.param as AnyNode | null);
        this.inScope(scope, () => {
          if (n.param) this.patternTargets(n.param as AnyNode);
          this.walk(n.body as AnyNode);
        });
        return;
      }
      case "MemberExpression":
        this.walk(n.object as AnyNode);
        if (n.computed) this.walk(n.property as AnyNode);
        return;
      case "Property":
        if (n.computed) this.walk(n.key as AnyNode);
        this.walk(n.value as AnyNode);
        return;
      case "LabeledStatement":
        this.walk(n.body as AnyNode);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
      case "PrivateIdentifier":
      case "ExportSpecifier":
        return;
      case "ObjectPattern":
      case "ArrayPattern":
      case "RestElement":
      case "AssignmentPattern":
        this.patternTargets(n);
        return;
    }
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const v = n[key];
      if (Array.isArray(v)) {
        for (const c of v)
          if (c && typeof c === "object" && typeof c.type === "string") this.walk(c);
      } else if (v && typeof v === "object" && typeof (v as AnyNode).type === "string") {
        this.walk(v as AnyNode);
      }
    }
  }
}

/** Every name a binding pattern declares. */
function patternNames(p: AnyNode): string[] {
  switch (p.type) {
    case "Identifier":
      return [p.name as string];
    case "ObjectPattern":
      return (p.properties as AnyNode[]).flatMap((prop) =>
        patternNames((prop.type === "RestElement" ? prop.argument : prop.value) as AnyNode),
      );
    case "ArrayPattern":
      return (p.elements as (AnyNode | null)[]).flatMap((e) => (e ? patternNames(e) : []));
    case "RestElement":
      return patternNames(p.argument as AnyNode);
    case "AssignmentPattern":
      return patternNames(p.left as AnyNode);
    default:
      return [];
  }
}

/** Statements and the parts of statements that can contain `var` declarations. */
function isStatement(n: AnyNode): boolean {
  return (
    n.type.endsWith("Statement") ||
    n.type === "VariableDeclaration" ||
    n.type === "SwitchCase" ||
    n.type === "CatchClause" ||
    n.type === "ExportNamedDeclaration" ||
    n.type === "ExportDefaultDeclaration"
  );
}
