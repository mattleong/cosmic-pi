import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { SandboxMap, SandboxSet, SandboxURLSearchParams } from "../values.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { boundedData } from "../stdlib/value.js";

import { assertBoundedCollectionSize } from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  isCallableReference,
} from "./model.js";
import {
  acquireIterator,
  closeOnAbrupt,
  hasSyncIterator,
  hasCustomSyncIterator,
  preflightSource,
  iteratorStep,
  makeNativeIterator,
  isNativeIterator,
  drainNativeIterator,
} from "./iterator-protocol.js";
import { invokeCallable } from "./callable.js";
import { type Activation } from "./activation.js";

export function invokeArrayFrom<R>(
  act: Activation<R>,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (args[2] !== undefined) {
    throw new InterpreterRuntimeError(
      "Array.from does not support thisArg in CodeMode.",
      node,
      "UnsupportedSyntax",
    );
  }
  const callback = args[1];
  if (callback !== undefined && !isCallableReference(callback)) {
    throw new InterpreterRuntimeError("Array.from expects a function mapper.", node).as(
      "TypeError",
    );
  }
  return Effect.gen(function* () {
    let source = args[0];
    if (isNativeIterator(source) && callback === undefined)
      return drainNativeIterator(source, node);
    if (
      !isNativeIterator(source) &&
      !hasCustomSyncIterator(source) &&
      !(source instanceof SandboxMap) &&
      !(source instanceof SandboxSet) &&
      !(source instanceof SandboxURLSearchParams)
    )
      boundedData(source, "Array.from input");
    preflightSource(source, node, "Array.from result");
    if (!hasSyncIterator(source)) {
      if (source == null)
        throw new InterpreterRuntimeError("Array.from requires a value.", node).as("TypeError");
      // SAFETY: Runtime object narrowing admits indexed own data reads only.
      const arrayLike =
        source !== null && hasObjectRuntimeType(source) ? (source as InterpreterObject) : undefined;
      const rawLength = arrayLike?.length;
      if (!Predicate.isNumber(rawLength))
        throw new InterpreterRuntimeError(
          "Array.from expects an array, string, Map, Set, or array-like value.",
          node,
        );
      const length = Number.isNaN(rawLength) ? 0 : Math.max(0, Math.trunc(rawLength));
      assertBoundedCollectionSize(length, "Array.from result", node);
      let index = 0;
      source = makeNativeIterator({
        next: () =>
          index < length
            ? { done: false, value: arrayLike?.[String(index++)] }
            : { done: true, value: undefined },
      });
    }
    const iterator = yield* acquireIterator(act, source, node, false, "Array.from result");
    const values: InterpreterArray = [];
    while (true) {
      const next = yield* iteratorStep(act, iterator, node);
      if (next.done) return values;
      yield* closeOnAbrupt(
        act,
        iterator,
        node,
        Effect.gen(function* () {
          assertBoundedCollectionSize(values.length + 1, "Array.from result", node);
          const mapped =
            callback === undefined
              ? next.value
              : yield* invokeCallable(act, callback, [next.value, values.length], node);
          values.push(mapped);
        }),
      );
    }
  });
}
