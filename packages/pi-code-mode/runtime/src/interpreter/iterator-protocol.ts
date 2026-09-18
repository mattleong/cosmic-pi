import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import type { RuntimeFailure } from "../failure.js";
import { SandboxMap, SandboxPromise, SandboxSet, SandboxURLSearchParams } from "../values.js";
import { assertBoundedCollectionSize, type ExecutionDeadline } from "./confinement.js";
import {
  GeneratorReference,
  GuestIterator,
  GuestAsyncIterator,
  IntrinsicReference,
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  isCallableReference,
  makeInterpreterObject,
} from "./model.js";

/** Only these owned cursors may dispatch a native iterator method. */
const nativeIterators = new WeakMap<
  InterpreterObject,
  { iterator: Iterator<InterpreterValue>; visited: number; label: string }
>();
export function makeNativeIterator(
  iterator: Iterator<InterpreterValue>,
  label = "Iterator visited entries",
): InterpreterObject {
  const value = makeInterpreterObject();
  nativeIterators.set(value, { iterator, visited: 0, label });
  value.next = new IntrinsicReference(value, "next");
  value[GuestIterator] = new IntrinsicReference(value, "iterator");
  return value;
}
export function isNativeIterator(value: InterpreterValue): value is InterpreterObject {
  // SAFETY: WeakMap membership only tests an object identity; it does not read record members.
  return (
    value !== null && hasObjectRuntimeType(value) && nativeIterators.has(value as InterpreterObject)
  );
}
export function invokeNativeIterator(
  ref: IntrinsicReference,
  _args: InterpreterArray,
  node: AstNode,
): InterpreterValue {
  if (!isNativeIterator(ref.receiver))
    throw new InterpreterRuntimeError("Invalid iterator receiver.", node).as("TypeError");
  if (ref.name === "iterator") return ref.receiver;
  if (ref.name !== "next")
    throw new InterpreterRuntimeError("Invalid iterator method.", node).as("TypeError");
  const state = nativeIterators.get(ref.receiver)!;
  const result = state.iterator.next();
  if (!result.done) assertBoundedCollectionSize(++state.visited, state.label, node);
  const value = makeInterpreterObject();
  value.done = !!result.done;
  value.value = result.value;
  return value;
}
export interface IteratorHost<R> {
  deadline: Pick<ExecutionDeadline, "check">;
  invokeCallable(
    callable: InterpreterValue,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  awaitIteratorPromise(
    promise: SandboxPromise,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, never>;
}
export interface IteratorRecord {
  readonly iterator: InterpreterValue;
  readonly source: InterpreterValue;
  readonly next: InterpreterValue;
  readonly async: boolean;
  readonly fromSync: boolean;
  done: boolean;
  visited: number;
  readonly label: string;
}
function iteratorMember(value: InterpreterValue, key: string | symbol): InterpreterValue {
  if (value instanceof GeneratorReference) {
    if (key === GuestIterator)
      return value.async ? undefined : new IntrinsicReference(value, "iterator");
    if (key === GuestAsyncIterator)
      return value.async ? new IntrinsicReference(value, "asyncIterator") : undefined;
    if (key === "next" || key === "return" || key === "throw")
      return new IntrinsicReference(value, key);
  }
  if (value === null || !hasObjectRuntimeType(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  // SAFETY: Own data descriptors belong to the closed InterpreterValue domain.
  return descriptor && "value" in descriptor ? (descriptor.value as InterpreterValue) : undefined;
}
export function preflightSource(
  value: InterpreterValue,
  node: AstNode,
  label = "Iterator source",
): void {
  if (Array.isArray(value) || Predicate.isString(value))
    assertBoundedCollectionSize(value.length, label, node);
  else if (value instanceof SandboxMap) assertBoundedCollectionSize(value.map.size, label, node);
  else if (value instanceof SandboxSet) assertBoundedCollectionSize(value.set.size, label, node);
  else if (value instanceof SandboxURLSearchParams)
    assertBoundedCollectionSize(value.params.size, label, node);
}
function nativeSource(value: InterpreterValue): IterableIterator<InterpreterValue> | undefined {
  if (Array.isArray(value) || Predicate.isString(value)) return value[Symbol.iterator]();
  if (value instanceof SandboxMap) return value.map.entries();
  if (value instanceof SandboxSet) return value.set.values();
  if (value instanceof SandboxURLSearchParams) return value.params.entries();
  return undefined;
}
export function makeNativeIteratorFor(value: InterpreterValue, node: AstNode): InterpreterObject {
  const iterator = nativeSource(value);
  if (!iterator) throw new InterpreterRuntimeError("Value is not iterable.", node).as("TypeError");
  return makeNativeIterator(iterator);
}
export function hasCustomSyncIterator(value: InterpreterValue): boolean {
  return iteratorMember(value, GuestIterator) != null;
}
export function hasSyncIterator(value: InterpreterValue): boolean {
  return iteratorMember(value, GuestIterator) != null || nativeSource(value) !== undefined;
}
export function acquireIterator<R>(
  host: IteratorHost<R>,
  value: InterpreterValue,
  node: AstNode,
  async = false,
  label = "Iterator visited entries",
): Effect.Effect<IteratorRecord, RuntimeFailure, R> {
  return Effect.gen(function* () {
    host.deadline.check(node);
    let method = async ? iteratorMember(value, GuestAsyncIterator) : undefined;
    const fromSync = async && method == null;
    if (method == null) method = iteratorMember(value, GuestIterator);
    let iterator: InterpreterValue;
    if (method != null) {
      if (!isCallableReference(method))
        throw new InterpreterRuntimeError("Iterator method is not callable.", node).as("TypeError");
      iterator =
        isNativeIterator(value) && method instanceof IntrinsicReference
          ? invokeNativeIterator(method, [], node)
          : yield* host.invokeCallable(method, [], node);
    } else {
      const native = nativeSource(value);
      if (!native)
        throw new InterpreterRuntimeError("Value is not iterable.", node).as("TypeError");
      iterator = makeNativeIterator(native, label);
    }
    if (iterator === null || !hasObjectRuntimeType(iterator) || iterator instanceof SandboxPromise)
      throw new InterpreterRuntimeError("Iterator method must return an object.", node).as(
        "TypeError",
      );
    const next = iteratorMember(iterator, "next");
    if (!isCallableReference(next))
      throw new InterpreterRuntimeError("Iterator next is not callable.", node).as("TypeError");
    return { iterator, source: value, next, async, fromSync, done: false, visited: 0, label };
  });
}
export function iteratorRequest<R>(
  host: IteratorHost<R>,
  record: IteratorRecord,
  method: "next" | "return" | "throw",
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<{ done: boolean; value: InterpreterValue }, RuntimeFailure, R> {
  return Effect.gen(function* () {
    host.deadline.check(node);
    const callable = method === "next" ? record.next : iteratorMember(record.iterator, method);
    if (callable == null && method === "return") {
      record.done = true;
      return { done: true, value: args[0] };
    }
    // Yield delegation closes a delegate without a throw method before reporting
    // the missing method. A failure from return takes precedence over that TypeError.
    if (callable == null && method === "throw") yield* iteratorClose(host, record, node);
    if (!isCallableReference(callable))
      throw new InterpreterRuntimeError(`Iterator ${method} is not callable.`, node).as(
        "TypeError",
      );
    let result =
      isNativeIterator(record.iterator) && callable instanceof IntrinsicReference
        ? invokeNativeIterator(callable, args, node)
        : yield* host.invokeCallable(callable, args, node);
    if (record.async && !record.fromSync && result instanceof SandboxPromise)
      result = yield* host.awaitIteratorPromise(result, node);
    if (result === null || !hasObjectRuntimeType(result))
      throw new InterpreterRuntimeError("Iterator result must be an object.", node).as("TypeError");
    const done = !!iteratorMember(result, "done");
    let value = iteratorMember(result, "value");
    if (record.fromSync && value instanceof SandboxPromise)
      value = yield* host.awaitIteratorPromise(value, node);
    if (done) record.done = true;
    return { done, value };
  });
}
export function iteratorStep<R>(
  host: IteratorHost<R>,
  record: IteratorRecord,
  node: AstNode,
  input?: InterpreterValue,
): Effect.Effect<{ done: boolean; value: InterpreterValue }, RuntimeFailure, R> {
  if (record.done) return Effect.succeed({ done: true, value: undefined });
  return Effect.map(
    iteratorRequest(host, record, "next", input === undefined ? [] : [input], node),
    (result) => {
      if (!result.done) assertBoundedCollectionSize(++record.visited, record.label, node);
      return result;
    },
  );
}
export function iteratorClose<R>(
  host: IteratorHost<R>,
  record: IteratorRecord,
  node: AstNode,
): Effect.Effect<void, RuntimeFailure, R> {
  if (record.done) return Effect.void;
  return Effect.asVoid(
    Effect.suspend(() => {
      record.done = true;
      return iteratorRequest(host, record, "return", [], node);
    }),
  );
}
/** Wrap the consumer body only: next/result failures must not close the iterator. */
export function closeOnAbrupt<A, R>(
  host: IteratorHost<R>,
  record: IteratorRecord,
  node: AstNode,
  body: Effect.Effect<A, RuntimeFailure, R>,
): Effect.Effect<A, RuntimeFailure, R> {
  return Effect.catchCause(body, (cause) => {
    const error = Cause.squash(cause);
    if (
      cause.reasons.some(Cause.isInterruptReason) ||
      (error instanceof InterpreterRuntimeError && error.kind === "TimeoutExceeded")
    )
      return Effect.failCause(cause);
    return Effect.flatMap(Effect.exit(iteratorClose(host, record, node)), () =>
      Effect.failCause(cause),
    );
  });
}
export function materializeIterable<R>(
  host: IteratorHost<R>,
  value: InterpreterValue,
  node: AstNode,
  label: string,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  return Effect.gen(function* () {
    preflightSource(value, node, label);
    // No guest callback runs during native traversal. Preflight bounds the allocation.
    if (!hasCustomSyncIterator(value)) {
      const native = nativeSource(value);
      if (native) return Array.from(native);
    }
    const record = yield* acquireIterator(host, value, node, false, label);
    const output: InterpreterArray = [];
    while (true) {
      const result = yield* iteratorStep(host, record, node);
      if (result.done) return output;
      yield* closeOnAbrupt(
        host,
        record,
        node,
        Effect.sync(() => {
          assertBoundedCollectionSize(output.length + 1, label, node);
          output.push(result.value);
        }),
      );
    }
  });
}
