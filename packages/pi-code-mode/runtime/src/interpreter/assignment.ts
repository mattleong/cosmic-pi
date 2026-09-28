import * as Effect from "effect/Effect";
import type { RuntimeFailure } from "../failure.js";
import { boundedData } from "../stdlib/value.js";
import { destructurePattern } from "./bindings.js";
import {
  type AstNode,
  getNode,
  getString,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "./model.js";
import { applyCompoundAssignment, evaluateExpression } from "./expressions.js";
import { resolveAssignmentReference } from "./member-writes.js";
import { getIdentifierValue, setIdentifierValue } from "./scope.js";
import type { Activation } from "./activation.js";

export interface AssignmentReference {
  get(): InterpreterValue;
  set(value: InterpreterValue): InterpreterValue;
}

function resolveReference<R>(
  host: Activation<R>,
  target: AstNode,
): Effect.Effect<AssignmentReference, RuntimeFailure, R> {
  if (target.type === "Identifier") {
    const name = getString(target, "name");
    return Effect.succeed({
      get: () => getIdentifierValue(host, name, target),
      set: (value) => setIdentifierValue(host, name, value, target),
    });
  }
  if (target.type === "MemberExpression") return resolveAssignmentReference(host, target);
  return Effect.sync(() => {
    throw new InterpreterRuntimeError(
      "Assignment target must be an Identifier or MemberExpression.",
      target,
    );
  });
}

export function assignExpression<R>(
  host: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const left = getNode(node, "left");
    const operator = getString(node, "operator");
    if (operator === "=" && (left.type === "ArrayPattern" || left.type === "ObjectPattern")) {
      const incoming = yield* evaluateExpression(host, getNode(node, "right"));
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
    const incoming = yield* evaluateExpression(host, getNode(node, "right"));
    const next =
      operator === "=" || operator === "??=" || operator === "||=" || operator === "&&="
        ? incoming
        : boundedData(
            applyCompoundAssignment(operator, current, incoming, node),
            "Assignment result",
          );
    return reference.set(next);
  });
}
