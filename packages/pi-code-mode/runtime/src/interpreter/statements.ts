import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import {
  acquireIterator,
  iteratorStep,
  iteratorClose,
  closeOnAbrupt,
} from "./iterator-protocol.js";
import { patternNames, predeclareLexicals } from "./scope.js";
import {
  asNode,
  type AstNode,
  astProperty,
  type AstPropertyValue,
  getArray,
  getBoolean,
  getNode,
  getOptionalNode,
  getString,
  InterpreterRuntimeError,
  isRecord,
  ProgramThrow,
  GeneratorReturn,
  type StatementResult,
  unsupportedSyntax,
  ToolReference,
} from "./model.js";
import { declarePattern, evaluateVariableDeclaration } from "./bindings.js";
import { createFunction } from "./callable.js";
import { evaluateExpression } from "./expressions.js";
import { currentScope, declare, popScope, pushScope, setIdentifierValue } from "./scope.js";
import { type Activation } from "./activation.js";
import { caughtErrorValue } from "./diagnostics.js";
import { containsOpaqueReference, isRuntimeReference } from "./references.js";

export function evaluateStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  // Wall-clock confinement: normalizes deadline expiry between synchronous steps.
  act.execution.deadline.check(node);
  switch (node.type) {
    case "LabeledStatement": {
      const labels: Array<string> = [];
      let body = node;
      while (body.type === "LabeledStatement") {
        labels.push(getString(getNode(body, "label"), "name"));
        body = getNode(body, "body");
      }
      return Effect.map(evaluateStatement(act, { ...body, controlLabels: labels }), (result) =>
        result.kind === "break" && result.label !== undefined && labels.includes(result.label)
          ? { kind: "none" }
          : result,
      );
    }
    case "ExpressionStatement":
      return Effect.map(evaluateExpression(act, getNode(node, "expression")), (value) => ({
        kind: "value",
        value,
      }));
    case "VariableDeclaration":
      return Effect.map(evaluateVariableDeclaration(act, node), () => ({ kind: "none" }));
    case "ReturnStatement": {
      const argumentNode = getOptionalNode(node, "argument");
      return argumentNode
        ? Effect.map(evaluateExpression(act, argumentNode), (value) => ({
            kind: "return",
            value,
          }))
        : Effect.succeed({ kind: "return", value: undefined });
    }
    case "BlockStatement":
      return evaluateBlock(act, node);
    case "IfStatement":
      return evaluateIfStatement(act, node);
    case "SwitchStatement":
      return evaluateSwitchStatement(act, node);
    case "WhileStatement":
      return evaluateWhileStatement(act, node);
    case "DoWhileStatement":
      return evaluateDoWhileStatement(act, node);
    case "ForStatement":
      return evaluateForStatement(act, node);
    case "ForOfStatement":
      return evaluateForOfStatement(act, node);
    case "ForInStatement":
      return evaluateForInStatement(act, node);
    case "BreakStatement":
      return Effect.succeed(evaluateBreakStatement(node));
    case "ContinueStatement":
      return Effect.succeed(evaluateContinueStatement(node));
    case "ThrowStatement":
      return evaluateThrowStatement(act, node);
    case "TryStatement":
      return evaluateTryStatement(act, node);
    case "EmptyStatement":
      return Effect.succeed({ kind: "none" });
    case "FunctionDeclaration":
      return Effect.succeed({ kind: "none" }); // bound ahead of time by hoistFunctions
    default:
      throw unsupportedSyntax(node.type, node);
  }
}

export function evaluateBlock<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const bodyEffect = Effect.gen(function* () {
    const body = getArray(node, "body");
    predeclareLexicals(currentScope(act), body);
    hoistFunctions(act, body);

    for (const statementValue of body) {
      const statement = asNode(statementValue, "body");
      const result = yield* evaluateStatement(act, statement);

      if (result.kind === "value") {
        act.lastValue = result.value;
        continue;
      }

      if (result.kind !== "none") {
        return result;
      }
    }

    return { kind: "none" } satisfies StatementResult;
  });
  return node.functionBody === true ? bodyEffect : withScope(act, bodyEffect);
}

function withScope<A, R>(
  host: Activation<R>,
  body: Effect.Effect<A, RuntimeFailure, R>,
): Effect.Effect<A, RuntimeFailure, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => pushScope(host)),
    () => body,
    () => Effect.sync(() => popScope(host)),
  );
}

export function hoistFunctions<R>(act: Activation<R>, statements: Array<AstPropertyValue>): void {
  for (const statementValue of statements) {
    if (!isRecord(statementValue) || astProperty(statementValue, "type") !== "FunctionDeclaration")
      continue;
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const node = statementValue as AstNode;
    const name = getString(getNode(node, "id"), "name");
    const existing = currentScope(act).get(name);
    if (existing?.initialized === true && existing.mutable)
      existing.value = createFunction(act, node);
    else declare(act, name, createFunction(act, node), true, node);
  }
}

export function evaluateIfStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const testNode = getNode(node, "test");
  const consequentNode = getNode(node, "consequent");
  const alternateNode = getOptionalNode(node, "alternate");

  return Effect.flatMap(evaluateExpression(act, testNode), (test) =>
    test
      ? evaluateStatement(act, consequentNode)
      : alternateNode
        ? evaluateStatement(act, alternateNode)
        : Effect.succeed({ kind: "none" }),
  );
}

export function evaluateSwitchStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return Effect.flatMap(evaluateExpression(act, getNode(node, "discriminant")), (discriminant) => {
    return withScope(
      act,
      Effect.gen(function* () {
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
        predeclareLexicals(currentScope(act), statements);
        hoistFunctions(act, statements);
        let defaultIndex: number | undefined;
        let selected: number | undefined;
        for (const [index, branch] of cases.entries()) {
          const test = getOptionalNode(branch, "test");
          if (!test) {
            defaultIndex = index;
            continue;
          }
          const candidate = yield* evaluateExpression(act, test);
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
            const result = yield* evaluateStatement(act, asNode(statementValue, "consequent"));
            if (result.kind === "break")
              return result.label === undefined
                ? ({ kind: "none" } satisfies StatementResult)
                : result;
            if (result.kind === "return" || result.kind === "continue") return result;
            if (result.kind === "value") act.lastValue = result.value;
          }
        }
        return { kind: "none" } satisfies StatementResult;
      }),
    );
  });
}

export function evaluateWhileStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const testNode = getNode(node, "test");
  const bodyNode = getNode(node, "body");

  return Effect.gen(function* () {
    while (yield* evaluateExpression(act, testNode)) {
      const result = yield* evaluateStatement(act, bodyNode);

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
        act.lastValue = result.value;
      }
    }

    return { kind: "none" } satisfies StatementResult;
  });
}

export function evaluateDoWhileStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const bodyNode = getNode(node, "body");
  const testNode = getNode(node, "test");

  return Effect.gen(function* () {
    do {
      const result = yield* evaluateStatement(act, bodyNode);

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
        act.lastValue = result.value;
      }
    } while (yield* evaluateExpression(act, testNode));

    return { kind: "none" } satisfies StatementResult;
  });
}

export function evaluateForStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return withScope(
    act,
    Effect.gen(function* () {
      const initNode = getOptionalNode(node, "init");
      const testNode = getOptionalNode(node, "test");
      const updateNode = getOptionalNode(node, "update");
      const bodyNode = getNode(node, "body");

      if (initNode) {
        if (initNode.type === "VariableDeclaration") {
          predeclareLexicals(currentScope(act), [initNode]);
          yield* evaluateVariableDeclaration(act, initNode);
        } else {
          yield* evaluateExpression(act, initNode);
        }
      }

      const perIterationBindings =
        initNode?.type === "VariableDeclaration" && getString(initNode, "kind") !== "var"
          ? Array.from(currentScope(act).keys())
          : [];

      const nextIteration = () => {
        if (perIterationBindings.length === 0) return;
        const previous = currentScope(act);
        const next = new Map(
          perIterationBindings.map((name) => [name, { ...previous.get(name)! }]),
        );
        popScope(act);
        act.scopes.push(next);
      };
      // Initializer closures retain the initialization environment. Each test and body
      // share their iteration environment; the update runs in the following one.
      nextIteration();
      while (testNode ? yield* evaluateExpression(act, testNode) : true) {
        const result = yield* evaluateStatement(act, bodyNode);

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
          act.lastValue = result.value;
        }

        nextIteration();

        if (updateNode) {
          yield* evaluateExpression(act, updateNode);
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
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return evaluateEnumeration<R>(act, node, true);
}

function evaluateEnumeration<R>(
  act: Activation<R>,
  node: AstNode,
  iterable: boolean,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const left = getNode(node, "left");
    const lexical = left.type === "VariableDeclaration" && getString(left, "kind") !== "var";
    // The RHS sees uninitialized lexical loop bindings, not an outer namesake.
    const right = yield* withScope(
      act,
      Effect.gen(function* () {
        if (lexical) predeclareLexicals(currentScope(act), [left]);
        return yield* evaluateExpression(act, getNode(node, "right"));
      }),
    );
    const keys = iterable ? undefined : enumerableKeys(act, right);
    if (!iterable && keys === undefined)
      throw new InterpreterRuntimeError(
        "for...in requires a plain object, array, or tools reference in CodeMode.",
        node,
      );
    const iterator = yield* acquireIterator(
      act,
      iterable ? right : keys!,
      node,
      iterable && getBoolean(node, "await"),
    );
    while (true) {
      const step = yield* iteratorStep(act, iterator, node);
      if (step.done) return { kind: "none" } satisfies StatementResult;
      const iteration = Effect.gen(function* () {
        if (left.type === "VariableDeclaration") {
          if (lexical) predeclareLexicals(currentScope(act), [left]);
          const declarations = getArray(left, "declarations");
          const pattern = getNode(asNode(declarations[0], "declarations[0]"), "id");
          yield* declarePattern(
            act,
            pattern,
            step.value,
            getString(left, "kind") !== "const",
            left,
            lexical ? undefined : "var",
          );
        } else if (left.type === "Identifier")
          setIdentifierValue(act, getString(left, "name"), step.value, left);
        else throw new InterpreterRuntimeError("Unsupported loop binding.", left);
        return yield* evaluateStatement(act, getNode(node, "body"));
      });
      const result = yield* closeOnAbrupt(act, iterator, node, withScope(act, iteration));
      if (result.kind === "value") act.lastValue = result.value;
      if (
        result.kind === "none" ||
        result.kind === "value" ||
        (result.kind === "continue" && targetsLoop(result, node))
      )
        continue;
      yield* iteratorClose(act, iterator, node);
      return result.kind === "break" && targetsLoop(result, node) ? { kind: "none" } : result;
    }
  });
}

export function enumerableKeys<R, ValueInput>(
  act: Activation<R>,
  value: ValueInput,
): Array<string> | undefined {
  if (value instanceof ToolReference) {
    return [...act.execution.toolKeys(value.path)];
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
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  return evaluateEnumeration<R>(act, node, false);
}

function targetsLoop(result: StatementResult, node: AstNode): boolean {
  if (result.kind !== "break" && result.kind !== "continue") return false;
  return (
    result.label === undefined ||
    (Array.isArray(node.controlLabels) && node.controlLabels.includes(result.label))
  );
}

export function evaluateBreakStatement(node: AstNode): StatementResult {
  const label = getOptionalNode(node, "label");
  return label ? { kind: "break", label: getString(label, "name") } : { kind: "break" };
}

export function evaluateContinueStatement(node: AstNode): StatementResult {
  const label = getOptionalNode(node, "label");
  return label ? { kind: "continue", label: getString(label, "name") } : { kind: "continue" };
}

export function evaluateThrowStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const argument = getNode(node, "argument");
  return Effect.flatMap(evaluateExpression(act, argument), (value) =>
    Effect.fail(new ProgramThrow(value)),
  );
}

export function evaluateTryStatement<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<StatementResult, RuntimeFailure, R> {
  const body = getNode(node, "block");
  const handler = getOptionalNode(node, "handler");
  const finalizer = getOptionalNode(node, "finalizer");

  const attempted = Effect.matchCauseEffect(evaluateStatement(act, body), {
    onFailure: (cause) => {
      if (hostTermination(cause) || Cause.squash(cause) instanceof GeneratorReturn || !handler) {
        return Effect.failCause(cause);
      }

      // The program sees a plain { message } error (or the thrown value itself) - see
      // caughtErrorValue, shared with Promise.allSettled rejection reasons.
      const caught = caughtErrorValue(Cause.squash(cause));
      const parameter = getOptionalNode(handler, "param");
      return withScope(
        act,
        Effect.gen(function* () {
          if (parameter) {
            for (const name of patternNames(parameter)) {
              currentScope(act).set(name, {
                value: undefined,
                mutable: true,
                initialized: false,
              });
            }
            yield* declarePattern(act, parameter, caught, true, handler);
          }
          return yield* evaluateStatement(act, getNode(handler, "body"));
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
        : Effect.flatMap(evaluateStatement(act, finalizer), (final) =>
            isAbrupt(final) ? Effect.succeed(final) : Effect.failCause(cause),
          ),
    onSuccess: (result) =>
      Effect.flatMap(evaluateStatement(act, finalizer), (final) =>
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
