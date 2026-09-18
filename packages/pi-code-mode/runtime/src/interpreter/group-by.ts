import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { coerceToString } from "../stdlib/value.js";
import { isBlockedMember } from "../tool-runtime.js";
import { SandboxMap } from "../values.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterValue,
  type CallableReference,
  isCallableReference,
  InterpreterRuntimeError,
  makeInterpreterObject,
} from "./model.js";

import {
  acquireIterator,
  preflightSource,
  iteratorStep,
  closeOnAbrupt,
  type IteratorHost,
} from "./iterator-protocol.js";

export type GroupByCallback = CallableReference;

// The invoker evaluates guest functions but must not await a returned SandboxPromise.
export const invokeGroupBy = <R>(
  namespace: "Object" | "Map",
  args: InterpreterArray,
  node: AstNode,
  invoke: (
    callback: GroupByCallback,
    args: InterpreterArray,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  checkDeadline: () => void,
  iteratorHost?: IteratorHost<R>,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> =>
  Effect.gen(function* () {
    const label = `${namespace}.groupBy`;
    const callback = args[1];
    if (!isCallableReference(callback)) {
      throw new InterpreterRuntimeError(`${label} expects a function callback.`, node);
    }
    const host: IteratorHost<R> = iteratorHost ?? {
      deadline: { check: checkDeadline },
      invokeCallable: (fn, items) => {
        if (!isCallableReference(fn))
          return Effect.fail(
            new InterpreterRuntimeError("Iterator method is not callable.", node).as("TypeError"),
          );
        return invoke(fn, items);
      },
      awaitIteratorPromise: () =>
        Effect.fail(new InterpreterRuntimeError("Grouping does not await promises.", node)),
    };
    preflightSource(args[0], node, label);
    const iterator = yield* acquireIterator(host, args[0], node, false, label);
    const groups = new Map<InterpreterValue, InterpreterArray>();
    const object = makeInterpreterObject();
    const map = new SandboxMap();
    let index = 0;
    while (true) {
      checkDeadline();
      const next = yield* iteratorStep(host, iterator, node);
      if (next.done) return namespace === "Object" ? object : map;
      // Charge total visited entries, not only live source size or distinct keys.
      // Delete/reinsert callbacks can otherwise keep a native iterator alive forever.
      assertBoundedCollectionSize(index + 1, `${label} entries`, node);
      yield* closeOnAbrupt(
        host,
        iterator,
        node,
        Effect.gen(function* () {
          const result = yield* invoke(callback, [next.value, index]);
          const key = namespace === "Object" ? coerceToString(result) : result;
          if (namespace === "Object" && Predicate.isString(key) && isBlockedMember(key)) {
            throw new InterpreterRuntimeError(
              `Property '${key}' is not available in CodeMode.`,
              node,
            );
          }
          let group = groups.get(key);
          if (group === undefined) {
            assertBoundedCollectionSize(groups.size + 1, `${label} groups`, node);
            group = [];
            groups.set(key, group);
            if (namespace === "Object") object[String(key)] = group;
            else map.map.set(key, group);
          }
          assertBoundedCollectionSize(group.length + 1, `${label} group`, node);
          group.push(next.value);
          index += 1;
        }),
      );
    }
  });
