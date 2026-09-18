import * as Effect from "effect/Effect";
import type { RuntimeFailure } from "../failure.js";
import { boundedData } from "../stdlib/value.js";
import { destructurePattern, type PatternHost } from "./bindings.js";
import {
  type AstNode,
  getNode,
  getString,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "./model.js";

export interface AssignmentReference {
  get(): InterpreterValue;
  set(value: InterpreterValue): InterpreterValue;
}
export interface AssignmentHost<R> extends PatternHost<R> {
  getIdentifierValue(name: string, node: AstNode): InterpreterValue;
  setIdentifierValue(name: string, value: InterpreterValue, node: AstNode): InterpreterValue;
  resolveAssignmentReference(node: AstNode): Effect.Effect<AssignmentReference, RuntimeFailure, R>;
  applyCompoundAssignment(
    operator: string,
    current: InterpreterValue,
    incoming: InterpreterValue,
    node: AstNode,
  ): InterpreterValue;
}

function resolveReference<R>(
  host: AssignmentHost<R>,
  target: AstNode,
): Effect.Effect<AssignmentReference, RuntimeFailure, R> {
  if (target.type === "Identifier") {
    const name = getString(target, "name");
    return Effect.succeed({
      get: () => host.getIdentifierValue(name, target),
      set: (value) => host.setIdentifierValue(name, value, target),
    });
  }
  if (target.type === "MemberExpression") return host.resolveAssignmentReference(target);
  return Effect.sync(() => {
    throw new InterpreterRuntimeError(
      "Assignment target must be an Identifier or MemberExpression.",
      target,
    );
  });
}

export function assignExpression<R>(
  host: AssignmentHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const left = getNode(node, "left");
    const operator = getString(node, "operator");
    if (operator === "=" && (left.type === "ArrayPattern" || left.type === "ObjectPattern")) {
      const incoming = yield* host.evaluateExpression(getNode(node, "right"));
      yield* destructurePattern(host, left, incoming, (target) =>
        Effect.map(
          resolveReference(host, target),
          (reference) => (value) => Effect.asVoid(Effect.sync(() => reference.set(value))),
        ),
      );
      return incoming;
    }
    const reference = yield* resolveReference(host, left);
    const current = operator === "=" ? undefined : reference.get();
    if (
      (operator === "??=" && current !== null && current !== undefined) ||
      (operator === "||=" && current) ||
      (operator === "&&=" && !current)
    )
      return current;
    const incoming = yield* host.evaluateExpression(getNode(node, "right"));
    const next =
      operator === "=" || operator === "??=" || operator === "||=" || operator === "&&="
        ? incoming
        : boundedData(
            host.applyCompoundAssignment(operator, current, incoming, node),
            "Assignment result",
          );
    return reference.set(next);
  });
}
