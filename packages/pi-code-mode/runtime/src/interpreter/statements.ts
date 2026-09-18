import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import {
  acquireIterator,
  iteratorStep,
  iteratorClose,
  closeOnAbrupt,
  type IteratorHost,
} from "./iterator-protocol.js";
import { patternNames, predeclareLexicals } from "./scope.js";
import { ToolReference } from "../tool-runtime.js";
import { ExecutionDeadline } from "./confinement.js";
import {
  asNode,
  type AstNode,
  astProperty,
  type AstPropertyValue,
  type Binding,
  CodeModeFunction,
  getArray,
  getBoolean,
  getNode,
  getOptionalNode,
  getString,
  InterpreterRuntimeError,
  type InterpreterValue,
  isRecord,
  ProgramThrow,
  GeneratorReturn,
  type StatementResult,
  unsupportedSyntax,
} from "./model.js";
import { caughtErrorValue, containsOpaqueReference, isRuntimeReference } from "./runtime.js";
export interface StatementsHost<R> extends IteratorHost<R> {
  createFunction(node: AstNode): CodeModeFunction;
  currentScope(): Map<string, Binding>;
  deadline: ExecutionDeadline;
  declare(name: string, value: InterpreterValue, mutable: boolean, node: AstNode): void;
  declarePattern(
    pattern: AstNode,
    value: InterpreterValue,
    mutable: boolean,
    node: AstNode,
    kind?: "var",
  ): Effect.Effect<void, RuntimeFailure, R>;
  enumerableKeys<ValueInput>(value: ValueInput): Array<string> | undefined;
  evaluateBlock(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateBreakStatement(node: AstNode): StatementResult;
  evaluateContinueStatement(node: AstNode): StatementResult;
  evaluateDoWhileStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateForInStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateForOfStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateForStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateIfStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateSwitchStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateThrowStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateTryStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  evaluateVariableDeclaration(node: AstNode): Effect.Effect<void, RuntimeFailure, R>;
  evaluateWhileStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  hoistFunctions(statements: Array<AstPropertyValue>): void;
  lastValue: InterpreterValue;
  popScope(): void;
  pushScope(): void;
  scopes: Array<Map<string, Binding>>;
  setIdentifierValue(name: string, value: InterpreterValue, node: AstNode): InterpreterValue;
  toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
}

export function evaluateStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  // Wall-clock confinement: normalizes deadline expiry between synchronous steps.
  this.deadline.check(node);
  switch (node.type) {
    case "LabeledStatement": {
      const labels: Array<string> = [];
      let body = node;
      while (body.type === "LabeledStatement") {
        labels.push(getString(getNode(body, "label"), "name"));
        body = getNode(body, "body");
      }
      return Effect.map(this.evaluateStatement({ ...body, controlLabels: labels }), (result) =>
        result.kind === "break" && result.label !== undefined && labels.includes(result.label)
          ? { kind: "none" }
          : result,
      );
    }
    case "ExpressionStatement":
      return Effect.map(this.evaluateExpression(getNode(node, "expression")), (value) => ({
        kind: "value",
        value,
      }));
    case "VariableDeclaration":
      return Effect.map(this.evaluateVariableDeclaration(node), () => ({ kind: "none" }));
    case "ReturnStatement": {
      const argumentNode = getOptionalNode(node, "argument");
      return argumentNode
        ? Effect.map(this.evaluateExpression(argumentNode), (value) => ({
            kind: "return",
            value,
          }))
        : Effect.succeed({ kind: "return", value: undefined });
    }
    case "BlockStatement":
      return this.evaluateBlock(node);
    case "IfStatement":
      return this.evaluateIfStatement(node);
    case "SwitchStatement":
      return this.evaluateSwitchStatement(node);
    case "WhileStatement":
      return this.evaluateWhileStatement(node);
    case "DoWhileStatement":
      return this.evaluateDoWhileStatement(node);
    case "ForStatement":
      return this.evaluateForStatement(node);
    case "ForOfStatement":
      return this.evaluateForOfStatement(node);
    case "ForInStatement":
      return this.evaluateForInStatement(node);
    case "BreakStatement":
      return Effect.succeed(this.evaluateBreakStatement(node));
    case "ContinueStatement":
      return Effect.succeed(this.evaluateContinueStatement(node));
    case "ThrowStatement":
      return this.evaluateThrowStatement(node);
    case "TryStatement":
      return this.evaluateTryStatement(node);
    case "EmptyStatement":
      return Effect.succeed({ kind: "none" });
    case "FunctionDeclaration":
      return Effect.succeed({ kind: "none" }); // bound ahead of time by hoistFunctions
    default:
      throw unsupportedSyntax(node.type, node);
  }
}

export function evaluateBlock<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const bodyEffect = Effect.gen({ self: this }, function* () {
    const body = getArray(node, "body");
    predeclareLexicals(this.currentScope(), body);
    this.hoistFunctions(body);

    for (const statementValue of body) {
      const statement = asNode(statementValue, "body");
      const result = yield* this.evaluateStatement(statement);

      if (result.kind === "value") {
        this.lastValue = result.value;
        continue;
      }

      if (result.kind !== "none") {
        return result;
      }
    }

    return { kind: "none" } satisfies StatementResult;
  });
  return node.functionBody === true ? bodyEffect : withScope(this, bodyEffect);
}

function withScope<A, R>(
  host: StatementsHost<R>,
  body: Effect.Effect<A, RuntimeFailure, R>,
): Effect.Effect<A, RuntimeFailure, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => host.pushScope()),
    () => body,
    () => Effect.sync(() => host.popScope()),
  );
}

export function hoistFunctions<R>(
  this: StatementsHost<R>,
  statements: Array<AstPropertyValue>,
): void {
  for (const statementValue of statements) {
    if (!isRecord(statementValue) || astProperty(statementValue, "type") !== "FunctionDeclaration")
      continue;
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const node = statementValue as AstNode;
    const name = getString(getNode(node, "id"), "name");
    const existing = this.currentScope().get(name);
    if (existing?.initialized === true && existing.mutable)
      existing.value = this.createFunction(node);
    else this.declare(name, this.createFunction(node), true, node);
  }
}

export function evaluateIfStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const testNode = getNode(node, "test");
  const consequentNode = getNode(node, "consequent");
  const alternateNode = getOptionalNode(node, "alternate");

  return Effect.flatMap(this.evaluateExpression(testNode), (test) =>
    test
      ? this.evaluateStatement(consequentNode)
      : alternateNode
        ? this.evaluateStatement(alternateNode)
        : Effect.succeed({ kind: "none" }),
  );
}

export function evaluateSwitchStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return Effect.flatMap(this.evaluateExpression(getNode(node, "discriminant")), (discriminant) => {
    return withScope(
      this,
      Effect.gen({ self: this }, function* () {
        if (containsOpaqueReference(discriminant)) {
          throw new InterpreterRuntimeError(
            "Switch discriminants must be data values in CodeMode.",
            node,
            "InvalidDataValue",
          );
        }
        const cases = getArray(node, "cases").map((value, index) =>
          asNode(value, `cases[${index}]`),
        );
        const statements = cases.flatMap((branch) => getArray(branch, "consequent"));
        predeclareLexicals(this.currentScope(), statements);
        this.hoistFunctions(statements);
        let defaultIndex: number | undefined;
        let selected: number | undefined;
        for (const [index, branch] of cases.entries()) {
          const test = getOptionalNode(branch, "test");
          if (!test) {
            defaultIndex = index;
            continue;
          }
          const candidate = yield* this.evaluateExpression(test);
          if (containsOpaqueReference(candidate)) {
            throw new InterpreterRuntimeError(
              "Switch case values must be data values in CodeMode.",
              test,
              "InvalidDataValue",
            );
          }
          if (candidate === discriminant) {
            selected = index;
            break;
          }
        }
        const start = selected ?? defaultIndex;
        if (start === undefined) return { kind: "none" } satisfies StatementResult;
        for (let index = start; index < cases.length; index += 1) {
          for (const statementValue of getArray(cases[index]!, "consequent")) {
            const result = yield* this.evaluateStatement(asNode(statementValue, "consequent"));
            if (result.kind === "break")
              return result.label === undefined
                ? ({ kind: "none" } satisfies StatementResult)
                : result;
            if (result.kind === "return" || result.kind === "continue") return result;
            if (result.kind === "value") this.lastValue = result.value;
          }
        }
        return { kind: "none" } satisfies StatementResult;
      }),
    );
  });
}

export function evaluateWhileStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const testNode = getNode(node, "test");
  const bodyNode = getNode(node, "body");

  return Effect.gen({ self: this }, function* () {
    while (yield* this.evaluateExpression(testNode)) {
      const result = yield* this.evaluateStatement(bodyNode);

      if (result.kind === "continue" && targetsLoop(result, node)) {
        continue;
      }

      if (result.kind === "break" && targetsLoop(result, node)) {
        return { kind: "none" } satisfies StatementResult;
      }

      if (
        result.kind === "return" ||
        ((result.kind === "break" || result.kind === "continue") && !targetsLoop(result, node))
      ) {
        return result;
      }

      if (result.kind === "value") {
        this.lastValue = result.value;
      }
    }

    return { kind: "none" } satisfies StatementResult;
  });
}

export function evaluateDoWhileStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const bodyNode = getNode(node, "body");
  const testNode = getNode(node, "test");

  return Effect.gen({ self: this }, function* () {
    do {
      const result = yield* this.evaluateStatement(bodyNode);

      if (result.kind === "continue" && targetsLoop(result, node)) {
        continue;
      }

      if (result.kind === "break" && targetsLoop(result, node)) {
        return { kind: "none" } satisfies StatementResult;
      }

      if (
        result.kind === "return" ||
        ((result.kind === "break" || result.kind === "continue") && !targetsLoop(result, node))
      ) {
        return result;
      }

      if (result.kind === "value") {
        this.lastValue = result.value;
      }
    } while (yield* this.evaluateExpression(testNode));

    return { kind: "none" } satisfies StatementResult;
  });
}

export function evaluateForStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return withScope(
    this,
    Effect.gen({ self: this }, function* () {
      const initNode = getOptionalNode(node, "init");
      const testNode = getOptionalNode(node, "test");
      const updateNode = getOptionalNode(node, "update");
      const bodyNode = getNode(node, "body");

      if (initNode) {
        if (initNode.type === "VariableDeclaration") {
          predeclareLexicals(this.currentScope(), [initNode]);
          yield* this.evaluateVariableDeclaration(initNode);
        } else {
          yield* this.evaluateExpression(initNode);
        }
      }

      const perIterationBindings =
        initNode?.type === "VariableDeclaration" && getString(initNode, "kind") !== "var"
          ? Array.from(this.currentScope().keys())
          : [];

      const nextIteration = () => {
        if (perIterationBindings.length === 0) return;
        const previous = this.currentScope();
        const next = new Map(
          perIterationBindings.map((name) => [name, { ...previous.get(name)! }]),
        );
        this.popScope();
        this.scopes.push(next);
      };
      // Initializer closures retain the initialization environment. Each test and body
      // share their iteration environment; the update runs in the following one.
      nextIteration();
      while (testNode ? yield* this.evaluateExpression(testNode) : true) {
        const result = yield* this.evaluateStatement(bodyNode);

        if (
          result.kind === "return" ||
          ((result.kind === "break" || result.kind === "continue") && !targetsLoop(result, node))
        ) {
          return result;
        }

        if (result.kind === "break" && targetsLoop(result, node)) {
          return { kind: "none" } satisfies StatementResult;
        }

        if (result.kind === "value") {
          this.lastValue = result.value;
        }

        nextIteration();

        if (updateNode) {
          yield* this.evaluateExpression(updateNode);
        }

        if (result.kind === "continue" && targetsLoop(result, node)) {
          continue;
        }
      }

      return { kind: "none" } satisfies StatementResult;
    }),
  );
}

export function evaluateForOfStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return evaluateEnumeration<R>(this, node, true);
}

function evaluateEnumeration<R>(
  host: StatementsHost<R>,
  node: AstNode,
  iterable: boolean,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return Effect.gen({ self: host }, function* () {
    const left = getNode(node, "left");
    const lexical = left.type === "VariableDeclaration" && getString(left, "kind") !== "var";
    // The RHS sees uninitialized lexical loop bindings, not an outer namesake.
    const right = yield* withScope(
      this,
      Effect.gen({ self: this }, function* () {
        if (lexical) predeclareLexicals(this.currentScope(), [left]);
        return yield* this.evaluateExpression(getNode(node, "right"));
      }),
    );
    const keys = iterable ? undefined : this.enumerableKeys(right);
    if (!iterable && keys === undefined)
      throw new InterpreterRuntimeError(
        "for...in requires a plain object, array, or tools reference in CodeMode.",
        node,
      );
    const iterator = yield* acquireIterator(
      this,
      iterable ? right : keys!,
      node,
      iterable && getBoolean(node, "await"),
    );
    while (true) {
      const step = yield* iteratorStep(this, iterator, node);
      if (step.done) return { kind: "none" } satisfies StatementResult;
      const iteration = Effect.gen({ self: this }, function* () {
        if (left.type === "VariableDeclaration") {
          if (lexical) predeclareLexicals(this.currentScope(), [left]);
          const declarations = getArray(left, "declarations");
          const pattern = getNode(asNode(declarations[0], "declarations[0]"), "id");
          yield* this.declarePattern(
            pattern,
            step.value,
            getString(left, "kind") !== "const",
            left,
            lexical ? undefined : "var",
          );
        } else if (left.type === "Identifier")
          this.setIdentifierValue(getString(left, "name"), step.value, left);
        else throw new InterpreterRuntimeError("Unsupported loop binding.", left);
        return yield* this.evaluateStatement(getNode(node, "body"));
      });
      const result = yield* closeOnAbrupt(this, iterator, node, withScope(this, iteration));
      if (result.kind === "value") this.lastValue = result.value;
      if (
        result.kind === "none" ||
        result.kind === "value" ||
        (result.kind === "continue" && targetsLoop(result, node))
      )
        continue;
      yield* iteratorClose(this, iterator, node);
      return result.kind === "break" && targetsLoop(result, node) ? { kind: "none" } : result;
    }
  });
}

export function enumerableKeys<R, ValueInput>(
  this: StatementsHost<R>,
  value: ValueInput,
): Array<string> | undefined {
  if (value instanceof ToolReference) {
    return [...this.toolKeys(value.path)];
  }
  if (Array.isArray(value)) {
    return Object.keys(value);
  }
  if (value !== null && hasObjectRuntimeType(value) && !isRuntimeReference(value)) {
    return Object.keys(value);
  }
  return undefined;
}

export function evaluateForInStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return evaluateEnumeration<R>(this, node, false);
}

function targetsLoop(result: StatementResult, node: AstNode): boolean {
  if (result.kind !== "break" && result.kind !== "continue") return false;
  return (
    result.label === undefined ||
    (Array.isArray(node.controlLabels) && node.controlLabels.includes(result.label))
  );
}

export function evaluateBreakStatement<R>(this: StatementsHost<R>, node: AstNode): StatementResult {
  const label = getOptionalNode(node, "label");
  return label ? { kind: "break", label: getString(label, "name") } : { kind: "break" };
}

export function evaluateContinueStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): StatementResult {
  const label = getOptionalNode(node, "label");
  return label ? { kind: "continue", label: getString(label, "name") } : { kind: "continue" };
}

export function evaluateThrowStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const argument = getNode(node, "argument");
  return Effect.flatMap(this.evaluateExpression(argument), (value) =>
    Effect.fail(new ProgramThrow(value)),
  );
}

export function evaluateTryStatement<R>(
  this: StatementsHost<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const body = getNode(node, "block");
  const handler = getOptionalNode(node, "handler");
  const finalizer = getOptionalNode(node, "finalizer");

  const attempted = Effect.matchCauseEffect(this.evaluateStatement(body), {
    onFailure: (cause) => {
      if (hostTermination(cause) || Cause.squash(cause) instanceof GeneratorReturn || !handler) {
        return Effect.failCause(cause);
      }

      // The program sees a plain { message } error (or the thrown value itself) - see
      // caughtErrorValue, shared with Promise.allSettled rejection reasons.
      const caught = caughtErrorValue(Cause.squash(cause));
      const parameter = getOptionalNode(handler, "param");
      return withScope(
        this,
        Effect.gen({ self: this }, function* () {
          if (parameter) {
            for (const name of patternNames(parameter)) {
              this.currentScope().set(name, {
                value: undefined,
                mutable: true,
                initialized: false,
              });
            }
            yield* this.declarePattern(parameter, caught, true, handler);
          }
          return yield* this.evaluateStatement(getNode(handler, "body"));
        }),
      );
    },
    onSuccess: Effect.succeed,
  });

  if (!finalizer) return attempted;

  const isAbrupt = (result: StatementResult): boolean =>
    result.kind === "return" || result.kind === "break" || result.kind === "continue";

  return Effect.matchCauseEffect(attempted, {
    onFailure: (cause) =>
      hostTermination(cause)
        ? Effect.failCause(cause)
        : Effect.flatMap(this.evaluateStatement(finalizer), (final) =>
            isAbrupt(final) ? Effect.succeed(final) : Effect.failCause(cause),
          ),
    onSuccess: (result) =>
      Effect.flatMap(this.evaluateStatement(finalizer), (final) =>
        isAbrupt(final) ? Effect.succeed(final) : Effect.succeed(result),
      ),
  });
}

function hostTermination(cause: Cause.Cause<RuntimeFailure>): boolean {
  const error = Cause.squash(cause);
  return (
    cause.reasons.some(Cause.isInterruptReason) ||
    (error instanceof InterpreterRuntimeError && error.kind === "TimeoutExceeded")
  );
}
