import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { SandboxMap, SandboxSet, SandboxURLSearchParams } from "../values.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { boundedData, coerceToNumber, coerceToString } from "../stdlib/value.js";

import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
  ExecutionDeadline,
} from "./confinement.js";
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
  type IteratorHost,
} from "./iterator-protocol.js";
export interface BuiltinsHost<R> extends IteratorHost<R> {
  applyCollectionCallback(
    callback: InterpreterValue,
    name: string,
    node: AstNode,
  ): (args: InterpreterArray) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  deadline: ExecutionDeadline;
  invokeCallable(
    callable: InterpreterValue,
    args: InterpreterArray,
    node: AstNode,
    callee?: InterpreterValue,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  rejectCircularInsertion(
    container: InterpreterObject | InterpreterArray,
    value: InterpreterValue,
    label: string,
    node: AstNode,
    seen?: InterpreterValue,
  ): void;
  sortArray(
    target: InterpreterArray,
    comparator: InterpreterValue,
    node: AstNode,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R>;
}

export function invokeArrayFrom<R>(
  this: BuiltinsHost<R>,
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
  return Effect.gen({ self: this }, function* () {
    let source = args[0];
    if (
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
    const iterator = yield* acquireIterator(this, source, node, false, "Array.from result");
    const values: InterpreterArray = [];
    while (true) {
      const next = yield* iteratorStep(this, iterator, node);
      if (next.done) return values;
      yield* closeOnAbrupt(
        this,
        iterator,
        node,
        Effect.gen({ self: this }, function* () {
          assertBoundedCollectionSize(values.length + 1, "Array.from result", node);
          const mapped =
            callback === undefined
              ? next.value
              : yield* this.invokeCallable(callback, [next.value, values.length], node);
          values.push(mapped);
        }),
      );
    }
  });
}

export function invokeArrayMethod<R>(
  this: BuiltinsHost<R>,
  target: InterpreterArray,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const optNumber = (value: InterpreterValue, label: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Predicate.isNumber(value))
      throw new InterpreterRuntimeError(`Array.${name} expects ${label} to be a number.`, node);
    return value;
  };
  switch (name) {
    case "join": {
      if (args.length > 1 || (args.length === 1 && !Predicate.isString(args[0]))) {
        throw new InterpreterRuntimeError(
          "Array.join expects zero arguments or one string separator.",
          node,
        );
      }
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      const input = boundedData(target, "Array.join input") as InterpreterArray;
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      const separator = args.length === 0 ? "," : (args[0] as string);
      // Confinement preflight: charge the joined length before the native join allocates.
      let joined = Math.max(0, input.length - 1) * separator.length;
      assertBoundedStringLength(joined, "Array.join", node);
      const parts = input.map((item) => {
        const part = coerceToString(item ?? "");
        joined += part.length;
        assertBoundedStringLength(joined, "Array.join", node);
        return part;
      });
      return Effect.succeed(parts.join(separator));
    }
    case "includes":
      if (args.length === 0 || args.length > 2)
        throw new InterpreterRuntimeError(
          "Array.includes expects a value and optional start index.",
          node,
        );
      return Effect.succeed(target.includes(args[0], optNumber(args[1], "start index")));
    case "indexOf":
      return Effect.succeed(target.indexOf(args[0], optNumber(args[1], "start index")));
    case "lastIndexOf":
      return Effect.succeed(
        args[1] === undefined
          ? target.lastIndexOf(args[0])
          : target.lastIndexOf(args[0], optNumber(args[1], "start index")),
      );
    case "at":
      return Effect.succeed(target.at(optNumber(args[0], "index") ?? 0));
    case "slice":
      return Effect.succeed(target.slice(optNumber(args[0], "start"), optNumber(args[1], "end")));
    case "concat": {
      assertBoundedCollectionSize(
        args.reduce(
          (total: number, item) => total + (Array.isArray(item) ? item.length : 1),
          target.length,
        ),
        "Array.concat",
        node,
      );
      return Effect.succeed(target.concat(...args));
    }
    case "flat": {
      const depth = optNumber(args[0], "depth") ?? 1;
      // Confinement preflight: the flattened entry count is projected (with the same
      // depth semantics as the native call) and the first overrun is refused before
      // native flat materializes anything. Guest arrays are acyclic (circular insertion
      // is rejected at every mutation door), so this walk terminates.
      const flattened: InterpreterArray = [];
      const flattenInto = (items: InterpreterArray, remaining: number): void => {
        for (const item of items) {
          if (remaining >= 1 && Array.isArray(item)) {
            flattenInto(item, remaining - 1);
          } else {
            assertBoundedCollectionSize(flattened.length + 1, "Array.flat", node);
            flattened.push(item);
          }
        }
      };
      flattenInto(target, depth);
      return Effect.succeed(flattened);
    }
    case "reverse":
      return Effect.succeed(target.reverse());
    case "sort": {
      const length = target.length;
      // Sort only present elements, then restore holes in the original index range.
      // Comparator side effects beyond that range must not be truncated away.
      const items = target.filter(() => true);
      return Effect.map(this.sortArray(items, args[0], node), (sorted) => {
        // A comparator may have changed the graph since its elements were collected.
        // Validate every reinsertion before writing any of the sorted snapshot back.
        for (const item of sorted)
          this.rejectCircularInsertion(target, item, "Array.sort result", node);
        for (const [index, item] of sorted.entries()) target[index] = item;
        for (let index = sorted.length; index < length; index += 1) delete target[index];
        return target;
      });
    }
    case "toSorted":
      return this.sortArray(target, args[0], node);
    case "toReversed":
      return Effect.succeed([...target].reverse());
    case "with": {
      const index = optNumber(args[0], "index") ?? 0;
      const resolved = index < 0 ? target.length + index : index;
      if (resolved < 0 || resolved >= target.length) {
        throw new InterpreterRuntimeError("Array.with index is out of range.", node);
      }
      const copied = [...target];
      copied[resolved] = args[1];
      return Effect.succeed(copied);
    }
    case "push": {
      // Validate before mutating (so no rollback is needed): inserting a container into
      // itself would create a cycle no later walk could survive.
      assertBoundedCollectionSize(target.length + args.length, "Array.push", node);
      for (const item of args)
        this.rejectCircularInsertion(target, item, "Array.push result", node);
      target.push(...args);
      return Effect.succeed(target.length);
    }
    case "unshift": {
      assertBoundedCollectionSize(target.length + args.length, "Array.unshift", node);
      for (const item of args)
        this.rejectCircularInsertion(target, item, "Array.unshift result", node);
      target.unshift(...args);
      return Effect.succeed(target.length);
    }
    case "pop":
      return Effect.succeed(target.pop());
    case "shift":
      return Effect.succeed(target.shift());
    case "toSpliced": {
      const length = target.length;
      const rawStart = optNumber(args[0], "start") ?? 0;
      const start = Number.isNaN(rawStart) ? 0 : Math.trunc(rawStart);
      const from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
      const rawDelete = optNumber(args[1], "delete count") ?? 0;
      const removed =
        args.length === 0
          ? 0
          : args.length === 1
            ? length - from
            : Math.min(
                Math.max(Number.isNaN(rawDelete) ? 0 : Math.trunc(rawDelete), 0),
                length - from,
              );
      const inserted = args.slice(2);
      assertBoundedCollectionSize(length - removed + inserted.length, "Array.toSpliced", node);
      const copied: InterpreterArray = [];
      // Read every retained index to densify holes. Avoid a native argument spread:
      // the collection cap is larger than engines' function-argument limits.
      for (let index = 0; index < from; index += 1) copied.push(target[index]);
      for (const item of inserted) copied.push(item);
      for (let index = from + removed; index < length; index += 1) copied.push(target[index]);
      return Effect.succeed(copied);
    }
    case "splice": {
      // Mutates in place and returns the removed elements, exactly like JS: one argument
      // removes to the end, an undefined delete count removes nothing.
      if (args.length === 0) return Effect.succeed(target.splice(0, 0));
      const start = optNumber(args[0], "start") ?? 0;
      if (args.length === 1) return Effect.succeed(target.splice(start));
      const deleteCount = optNumber(args[1], "delete count") ?? 0;
      const inserted = args.slice(2);
      assertBoundedCollectionSize(target.length + inserted.length, "Array.splice", node);
      for (const item of inserted)
        this.rejectCircularInsertion(target, item, "Array.splice result", node);
      return Effect.succeed(target.splice(start, deleteCount, ...inserted));
    }
    case "fill": {
      this.rejectCircularInsertion(target, args[0], "Array.fill result", node);
      return Effect.succeed(
        target.fill(args[0], optNumber(args[1], "start"), optNumber(args[2], "end")),
      );
    }
    case "copyWithin":
      return Effect.succeed(
        target.copyWithin(
          optNumber(args[0], "target index") ?? 0,
          optNumber(args[1], "start") ?? 0,
          optNumber(args[2], "end"),
        ),
      );
    case "keys":
      return Effect.succeed(Array.from(target.keys()));
    case "values":
      return Effect.succeed(Array.from(target.values()));
    case "entries":
      return Effect.succeed(Array.from(target.entries()));
  }

  const apply = this.applyCollectionCallback(args[0], `Array.${name}`, node);
  return Effect.gen({ self: this }, function* () {
    // Iterate a snapshot taken at call time so a callback that mutates the array can't
    // self-extend the loop - matching JS, where elements appended during iteration are not visited.
    const items = target.slice();
    switch (name) {
      case "map": {
        const values: InterpreterArray = [];
        for (const [index, item] of items.entries())
          values.push(yield* apply([item, index, items]));
        return values;
      }
      case "flatMap": {
        const values: InterpreterArray = [];
        for (const [index, item] of items.entries()) {
          const mapped = yield* apply([item, index, items]);
          assertBoundedCollectionSize(
            values.length + (Array.isArray(mapped) ? mapped.length : 1),
            "Array.flatMap",
            node,
          );
          if (Array.isArray(mapped)) {
            for (const item of mapped) values.push(item);
          } else values.push(mapped);
        }
        return values;
      }
      case "filter": {
        const values: InterpreterArray = [];
        for (const [index, item] of items.entries()) {
          if (yield* apply([item, index, items])) values.push(item);
        }
        return values;
      }
      case "find":
        for (const [index, item] of items.entries()) {
          if (yield* apply([item, index, items])) return item;
        }
        return undefined;
      case "findIndex":
        for (const [index, item] of items.entries()) {
          if (yield* apply([item, index, items])) return index;
        }
        return -1;
      case "some":
        for (const [index, item] of items.entries()) {
          if (yield* apply([item, index, items])) return true;
        }
        return false;
      case "every":
        for (const [index, item] of items.entries()) {
          if (!(yield* apply([item, index, items]))) return false;
        }
        return true;
      case "forEach":
        for (const [index, item] of items.entries()) yield* apply([item, index, items]);
        return undefined;
      case "reduce": {
        let accumulator: InterpreterValue;
        let start: number;
        if (args.length >= 2) {
          accumulator = args[1];
          start = 0;
        } else {
          if (items.length === 0)
            throw new InterpreterRuntimeError(
              "Array.reduce of an empty array with no initial value.",
              node,
            );
          accumulator = items[0];
          start = 1;
        }
        for (let index = start; index < items.length; index += 1) {
          accumulator = yield* apply([accumulator, items[index], index, items]);
        }
        return accumulator;
      }
      case "reduceRight": {
        let accumulator: InterpreterValue;
        let start: number;
        if (args.length >= 2) {
          accumulator = args[1];
          start = items.length - 1;
        } else {
          if (items.length === 0)
            throw new InterpreterRuntimeError(
              "Array.reduceRight of an empty array with no initial value.",
              node,
            );
          accumulator = items[items.length - 1];
          start = items.length - 2;
        }
        for (let index = start; index >= 0; index -= 1) {
          accumulator = yield* apply([accumulator, items[index], index, items]);
        }
        return accumulator;
      }
      case "findLast":
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (yield* apply([items[index], index, items])) return items[index];
        }
        return undefined;
      case "findLastIndex":
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (yield* apply([items[index], index, items])) return index;
        }
        return -1;
    }
    throw new InterpreterRuntimeError(`Array method '${name}' is not available in CodeMode.`, node);
  });
}

export function sortArray<R>(
  this: BuiltinsHost<R>,
  target: InterpreterArray,
  comparator: InterpreterValue,
  node: AstNode,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  if (comparator !== undefined && !isCallableReference(comparator)) {
    throw new InterpreterRuntimeError("Array.sort expects a function comparator.", node);
  }
  if (comparator === undefined) {
    return Effect.sync(() =>
      [...target].sort((a, b) => {
        const left = coerceToString(a);
        const right = coerceToString(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    );
  }
  const apply = this.applyCollectionCallback(comparator, "Array.sort", node);
  const mergeSort = (
    items: InterpreterArray,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R> => {
    if (items.length <= 1) return Effect.succeed(items);
    const midpoint = Math.floor(items.length / 2);
    return Effect.gen({ self: this }, function* () {
      const left = yield* mergeSort(items.slice(0, midpoint));
      const right = yield* mergeSort(items.slice(midpoint));
      const merged: InterpreterArray = [];
      let leftIndex = 0;
      let rightIndex = 0;
      while (leftIndex < left.length && rightIndex < right.length) {
        // Coerce the comparator's result like JS ToNumber (data objects -> NaN, never a host
        // crash) and treat NaN as 0 - the spec's "no consistent order" -> keep the left element.
        const order = coerceToNumber(yield* apply([left[leftIndex], right[rightIndex]]));
        if (Number.isNaN(order) || order <= 0) merged.push(left[leftIndex++]);
        else merged.push(right[rightIndex++]);
      }
      return [...merged, ...left.slice(leftIndex), ...right.slice(rightIndex)];
    });
  };
  // Per spec, undefined elements sort to the end and the comparator is never called on them.
  const defined = target.filter((item) => item !== undefined);
  const undefinedCount = target.length - defined.length;
  return Effect.map(mergeSort(defined), (items) => [
    ...items,
    ...Array(undefinedCount).fill(undefined),
  ]);
}
