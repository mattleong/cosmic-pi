import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { coerceToString } from "../stdlib/value.js";
import { isBlockedMember } from "../tool-runtime.js";
import { SandboxMap, SandboxSet, SandboxURLSearchParams } from "../values.js";
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
): Effect.Effect<InterpreterValue, RuntimeFailure, R> =>
  Effect.gen(function* () {
    const label = `${namespace}.groupBy`;
    const callback = args[1];
    if (!isCallableReference(callback)) {
      throw new InterpreterRuntimeError(`${label} expects a function callback.`, node);
    }
    const source = args[0];
    let iterator: Iterator<InterpreterValue>;
    let sourceSize: () => number;
    // These are owned interpreter containers. Do not checkpoint-copy their members:
    // opaque values and aliases are valid entries and must retain their identity.
    if (Array.isArray(source) || Predicate.isString(source)) {
      sourceSize = () => source.length;
      iterator = source[Symbol.iterator]();
    } else if (source instanceof SandboxMap) {
      sourceSize = () => source.map.size;
      iterator = source.map.entries();
    } else if (source instanceof SandboxSet) {
      sourceSize = () => source.set.size;
      iterator = source.set.values();
    } else if (source instanceof SandboxURLSearchParams) {
      sourceSize = () => source.params.size;
      iterator = source.params.entries();
    } else {
      throw new InterpreterRuntimeError(
        `${label} expects an array, string, Map, Set, or URLSearchParams.`,
        node,
      );
    }
    const groups = new Map<InterpreterValue, InterpreterArray>();
    const object = makeInterpreterObject();
    const map = new SandboxMap();
    let index = 0;
    while (true) {
      checkDeadline();
      assertBoundedCollectionSize(sourceSize(), `${label} source`, node);
      const next = iterator.next();
      if (next.done) return namespace === "Object" ? object : map;
      // Charge total visited entries, not only live source size or distinct keys.
      // Delete/reinsert callbacks can otherwise keep a native iterator alive forever.
      assertBoundedCollectionSize(index + 1, `${label} entries`, node);
      const result = yield* invoke(callback, [next.value, index]);
      const key = namespace === "Object" ? coerceToString(result) : result;
      if (namespace === "Object" && Predicate.isString(key) && isBlockedMember(key)) {
        throw new InterpreterRuntimeError(`Property '${key}' is not available in CodeMode.`, node);
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
    }
  });
