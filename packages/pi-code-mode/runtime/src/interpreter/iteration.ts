import * as Effect from "effect/Effect";
import type { RuntimeFailure } from "../failure.js";
import { uriArgument } from "../stdlib/url.js";
import { boundedData } from "../stdlib/value.js";
import { coerceToString } from "./conversions.js";
import { SandboxMap, SandboxPromise, SandboxSet, SandboxURLSearchParams } from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
  uriEncodedLengthUpperBound,
} from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  isCallableReference,
} from "./model.js";
import { invokeSetOperation, type SetOperation } from "./set-operations.js";
import { collectReplaceMatches, ReplacementOutput } from "./string-replace.js";
import { makeNativeIterator } from "./iterator-protocol.js";
import { invokeCallable } from "./callable.js";
import { type Activation } from "./activation.js";
import { MethodTable } from "../stdlib/method-table.js";

export function invokeStringReplacer<R>(
  act: Activation<R>,
  value: string,
  name: "replace" | "replaceAll",
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const apply = applyCollectionCallback(act, args[1], `String.${name}`, node);
  const matches = collectReplaceMatches(value, name, args[0], node);
  return Effect.gen(function* () {
    const output = new ReplacementOutput(`String.${name} result`, node);
    let end = 0;
    for (const match of matches) {
      output.push(value.slice(end, match.offset));
      const replacement = yield* apply(match.args);
      // Replacers do not await callbacks. Coercion here is not a data-boundary escape
      // and does not observe a returned promise's rejection.
      output.push(
        replacement instanceof SandboxPromise
          ? "[object Promise]"
          : coerceToString(boundedData(replacement, `String.${name} replacer result`)),
      );
      end = match.offset + match.match.length;
    }
    output.push(value.slice(end));
    return boundedData(output.finish(), `String.${name} result`);
  });
}

export function applyCollectionCallback<R>(
  act: Activation<R>,
  callback: InterpreterValue,
  name: string,
  node: AstNode,
): (args: InterpreterArray) => Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (!isCallableReference(callback)) {
    throw new InterpreterRuntimeError(`${name} expects a function callback.`, node);
  }
  return (callbackArgs) =>
    Effect.suspend(() => {
      act.execution.deadline.check(node);
      return invokeCallable(act, callback, callbackArgs, node);
    });
}

/** One collection method call: the calling activation, receiver, and arguments. */
interface CollectionCall<Target, R> {
  readonly act: Activation<R>;
  readonly target: Target;
  readonly name: string;
  readonly args: InterpreterArray;
  readonly node: AstNode;
}

type CollectionMethod<Target> = <R>(
  call: CollectionCall<Target, R>,
) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;

/** Visits a collection's entries for forEach, checking the deadline and visit cap each step. */
const forEachEntry = <R, Entry>(
  { act, node }: CollectionCall<unknown, R>,
  label: string,
  entries: () => Iterable<Entry>,
  callback: InterpreterValue,
  argumentsFor: (entry: Entry) => InterpreterArray,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> => {
  const apply = applyCollectionCallback(act, callback, `${label}.forEach`, node);
  return Effect.gen(function* () {
    let visited = 0;
    for (const entry of entries()) {
      act.execution.deadline.check(node);
      assertBoundedCollectionSize(++visited, `${label}.forEach entries`, node);
      yield* apply(argumentsFor(entry));
    }
    return undefined;
  });
};

const dispatch = <Target, R>(
  table: MethodTable<CollectionMethod<Target>>,
  kind: string,
  call: CollectionCall<Target, R>,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> => {
  const method = table.get(call.name);
  if (method === undefined)
    throw new InterpreterRuntimeError(
      `${kind} method '${call.name}' is not available in CodeMode.`,
      call.node,
    );
  return method(call);
};

export const mapMethods = new MethodTable<CollectionMethod<SandboxMap>>({
  get: ({ target, args }) => Effect.succeed(target.map.get(args[0])),
  has: ({ target, args }) => Effect.succeed(target.map.has(args[0])),
  set: ({ target, args, node }) =>
    Effect.sync(() => {
      if (!target.map.has(args[0])) {
        assertBoundedCollectionSize(target.map.size + 1, "Map.set", node);
      }
      target.map.set(args[0], args[1]);
      return target;
    }),
  delete: ({ target, args }) => Effect.sync(() => target.map.delete(args[0])),
  clear: ({ target }) =>
    Effect.sync(() => {
      target.map.clear();
      return undefined;
    }),
  // Live iterators, as in JS: entries added during iteration are visited, deleted ones are not.
  keys: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.map.keys(), "Map.keys entries")),
  values: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.map.values(), "Map.values entries")),
  entries: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.map.entries(), "Map.entries entries")),
  forEach: (call) =>
    forEachEntry(
      call,
      "Map",
      () => call.target.map.entries(),
      call.args[0],
      ([key, item]) => [item, key, call.target],
    ),
});

const setOperation =
  (operation: SetOperation): CollectionMethod<SandboxSet> =>
  ({ act, target, args, node }) =>
    Effect.sync(() => invokeSetOperation(target, operation, args[0], act.execution.deadline, node));

export const setMethods = new MethodTable<CollectionMethod<SandboxSet>>({
  union: setOperation("union"),
  intersection: setOperation("intersection"),
  difference: setOperation("difference"),
  symmetricDifference: setOperation("symmetricDifference"),
  isSubsetOf: setOperation("isSubsetOf"),
  isSupersetOf: setOperation("isSupersetOf"),
  isDisjointFrom: setOperation("isDisjointFrom"),
  has: ({ target, args }) => Effect.succeed(target.set.has(args[0])),
  add: ({ target, args, node }) =>
    Effect.sync(() => {
      if (!target.set.has(args[0])) {
        assertBoundedCollectionSize(target.set.size + 1, "Set.add", node);
      }
      target.set.add(args[0]);
      return target;
    }),
  delete: ({ target, args }) => Effect.sync(() => target.set.delete(args[0])),
  clear: ({ target }) =>
    Effect.sync(() => {
      target.set.clear();
      return undefined;
    }),
  keys: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.set.values(), "Set.keys entries")),
  values: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.set.values(), "Set.values entries")),
  entries: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.set.entries(), "Set.entries entries")),
  forEach: (call) =>
    forEachEntry(
      call,
      "Set",
      () => call.target.set.values(),
      call.args[0],
      (item) => [item, item, call.target],
    ),
});

/** A URLSearchParams string argument, and the minimum argument count a method requires. */
const paramArgument = (
  { name, args }: CollectionCall<SandboxURLSearchParams, unknown>,
  index: number,
): string => uriArgument(args[index], `URLSearchParams.${name} argument ${index + 1}`);

const requireParamArguments = (
  { name, args, node }: CollectionCall<SandboxURLSearchParams, unknown>,
  count: number,
): void => {
  if (args.length < count) {
    throw new InterpreterRuntimeError(
      `URLSearchParams.${name} requires ${count} argument${count === 1 ? "" : "s"}.`,
      node,
    ).as("TypeError");
  }
};

export const urlSearchParamsMethods = new MethodTable<CollectionMethod<SandboxURLSearchParams>>({
  append: (call) => {
    requireParamArguments(call, 2);
    return Effect.sync(() => {
      assertBoundedCollectionSize(call.target.params.size + 1, "URLSearchParams.append", call.node);
      call.target.params.append(paramArgument(call, 0), paramArgument(call, 1));
      return undefined;
    });
  },
  delete: (call) => {
    requireParamArguments(call, 1);
    return Effect.sync(() => {
      if (call.args[1] !== undefined)
        call.target.params.delete(paramArgument(call, 0), paramArgument(call, 1));
      else call.target.params.delete(paramArgument(call, 0));
      return undefined;
    });
  },
  get: (call) => {
    requireParamArguments(call, 1);
    return Effect.sync(() => call.target.params.get(paramArgument(call, 0)));
  },
  getAll: (call) => {
    requireParamArguments(call, 1);
    return Effect.sync(() => {
      // Confinement preflight: the result is at most one entry per stored pair.
      assertBoundedCollectionSize(call.target.params.size, "URLSearchParams.getAll", call.node);
      return call.target.params.getAll(paramArgument(call, 0));
    });
  },
  has: (call) => {
    requireParamArguments(call, 1);
    return Effect.sync(() =>
      call.args[1] !== undefined
        ? call.target.params.has(paramArgument(call, 0), paramArgument(call, 1))
        : call.target.params.has(paramArgument(call, 0)),
    );
  },
  set: (call) => {
    requireParamArguments(call, 2);
    return Effect.sync(() => {
      const key = paramArgument(call, 0);
      if (!call.target.params.has(key)) {
        assertBoundedCollectionSize(call.target.params.size + 1, "URLSearchParams.set", call.node);
      }
      call.target.params.set(key, paramArgument(call, 1));
      return undefined;
    });
  },
  sort: ({ target }) =>
    Effect.sync(() => {
      target.params.sort();
      return undefined;
    }),
  // Live iterators; each visited entry is counted against the collection cap.
  keys: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.params.keys(), "URLSearchParams.keys entries")),
  values: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.params.values(), "URLSearchParams.values entries")),
  entries: ({ target }) =>
    Effect.sync(() =>
      makeNativeIterator(target.params.entries(), "URLSearchParams.entries entries"),
    ),
  // `toString` is typed explicitly: object literals type that key from Object.prototype.
  toString: <R>({
    target,
    node,
  }: CollectionCall<SandboxURLSearchParams, R>): Effect.Effect<
    InterpreterValue,
    RuntimeFailure,
    R
  > =>
    Effect.sync(() => {
      // Confinement preflight: the serialized worst case (percent-encoding expansion)
      // is charged entry by entry before the native serializer materializes it.
      let projected = 0;
      for (const [key, value] of target.params.entries()) {
        projected += uriEncodedLengthUpperBound(key) + uriEncodedLengthUpperBound(value) + 2;
        assertBoundedStringLength(projected, "URLSearchParams.toString", node);
      }
      return target.params.toString();
    }),
  forEach: (call) => {
    requireParamArguments(call, 1);
    assertBoundedCollectionSize(call.target.params.size, "URLSearchParams.forEach", call.node);
    return forEachEntry(
      call,
      "URLSearchParams",
      () => call.target.params.entries(),
      call.args[0],
      ([key, value]) => [value, key, call.target],
    );
  },
});

export function invokeMapMethod<R>(
  act: Activation<R>,
  target: SandboxMap,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return dispatch(mapMethods, "Map", { act, target, name, args, node });
}

export function invokeSetMethod<R>(
  act: Activation<R>,
  target: SandboxSet,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return dispatch(setMethods, "Set", { act, target, name, args, node });
}

export function invokeURLSearchParamsMethod<R>(
  act: Activation<R>,
  target: SandboxURLSearchParams,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return dispatch(urlSearchParamsMethods, "URLSearchParams", { act, target, name, args, node });
}
