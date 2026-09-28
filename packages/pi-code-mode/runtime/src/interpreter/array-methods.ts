import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { MethodTable } from "../stdlib/method-table.js";
import { boundedData } from "../stdlib/value.js";
import { coerceToNumber, coerceToString } from "./conversions.js";
import type { Activation } from "./activation.js";
import { assertBoundedCollectionSize, assertBoundedStringLength } from "./confinement.js";
import { makeNativeIterator } from "./iterator-protocol.js";
import { applyCollectionCallback } from "./iteration.js";
import { rejectCircularInsertion } from "./member-writes.js";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  isCallableReference,
} from "./model.js";

/** One array method call: the calling activation, receiver, and arguments. */
interface ArrayCall<R> {
  readonly act: Activation<R>;
  readonly target: InterpreterArray;
  readonly name: string;
  readonly args: InterpreterArray;
  readonly node: AstNode;
}

type ArrayMethod = <R>(call: ArrayCall<R>) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;

/** An optional numeric argument; messages name the method and argument. */
const optNumber = (
  { name, node }: ArrayCall<unknown>,
  value: InterpreterValue,
  label: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Predicate.isNumber(value))
    throw new InterpreterRuntimeError(`Array.${name} expects ${label} to be a number.`, node);
  return value;
};

const join = <R>(
  { target, node }: ArrayCall<R>,
  separatorArgs: InterpreterArray,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> => {
  if (
    separatorArgs.length > 1 ||
    (separatorArgs.length === 1 && !Predicate.isString(separatorArgs[0]))
  ) {
    throw new InterpreterRuntimeError(
      "Array.join expects zero arguments or one string separator.",
      node,
    );
  }
  // SAFETY: The data checkpoint returns an array copy for an array input.
  const input = boundedData(target, "Array.join input") as InterpreterArray;
  const separator = Predicate.isString(separatorArgs[0]) ? separatorArgs[0] : ",";
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
};

/**
 * Spec-shaped iteration for callback methods: the length is fixed at the call, so elements a
 * callback appends are not visited; elements are read live and callbacks receive the array.
 */
const iteration = <R>({ act, target, name, args, node }: ArrayCall<R>) => {
  const apply = applyCollectionCallback(act, args[0], `Array.${name}`, node);
  return {
    length: target.length,
    apply,
    /** Holes are skipped by most callback methods; the find family visits them as undefined. */
    present: (index: number): boolean => Object.hasOwn(target, index),
    call: (item: InterpreterValue, index: number) => apply([item, index, target]),
  };
};

const emptyReduce = ({ name, node }: ArrayCall<unknown>) =>
  new InterpreterRuntimeError(`Array.${name} of an empty array with no initial value.`, node).as(
    "TypeError",
  );

export const arrayMethods = new MethodTable<ArrayMethod>({
  join: (call) => join(call, call.args),
  // `toString` is typed explicitly: object literals type that key from Object.prototype.
  toString: <R>(call: ArrayCall<R>) => join(call, []),
  includes: (call) => {
    if (call.args.length === 0 || call.args.length > 2)
      throw new InterpreterRuntimeError(
        "Array.includes expects a value and optional start index.",
        call.node,
      );
    return Effect.succeed(
      call.target.includes(call.args[0], optNumber(call, call.args[1], "start index")),
    );
  },
  indexOf: (call) =>
    Effect.succeed(call.target.indexOf(call.args[0], optNumber(call, call.args[1], "start index"))),
  lastIndexOf: (call) =>
    Effect.succeed(
      call.args[1] === undefined
        ? call.target.lastIndexOf(call.args[0])
        : call.target.lastIndexOf(call.args[0], optNumber(call, call.args[1], "start index")),
    ),
  at: (call) => Effect.succeed(call.target.at(optNumber(call, call.args[0], "index") ?? 0)),
  slice: (call) =>
    Effect.succeed(
      call.target.slice(
        optNumber(call, call.args[0], "start"),
        optNumber(call, call.args[1], "end"),
      ),
    ),
  concat: ({ target, args, node }) => {
    assertBoundedCollectionSize(
      args.reduce(
        (total: number, item) => total + (Array.isArray(item) ? item.length : 1),
        target.length,
      ),
      "Array.concat",
      node,
    );
    return Effect.succeed(target.concat(...args));
  },
  flat: (call) => {
    const depth = optNumber(call, call.args[0], "depth") ?? 1;
    // Confinement preflight: the flattened entry count is projected (with the same depth
    // semantics as the native call) and the first overrun is refused before anything is
    // materialized. Guest arrays are acyclic (circular insertion is rejected at every
    // mutation door), so this walk terminates. Holes are skipped, as in JS.
    const flattened: InterpreterArray = [];
    const flattenInto = (items: InterpreterArray, remaining: number): void => {
      for (let index = 0; index < items.length; index += 1) {
        if (!Object.hasOwn(items, index)) continue;
        const item = items[index];
        if (remaining >= 1 && Array.isArray(item)) {
          flattenInto(item, remaining - 1);
        } else {
          assertBoundedCollectionSize(flattened.length + 1, "Array.flat", call.node);
          flattened.push(item);
        }
      }
    };
    flattenInto(call.target, depth);
    return Effect.succeed(flattened);
  },
  reverse: ({ target }) => Effect.succeed(target.reverse()),
  sort: ({ act, target, args, node }) => {
    const length = target.length;
    // Sort only present elements, then restore holes in the original index range.
    // Comparator side effects beyond that range must not be truncated away.
    const items = target.filter(() => true);
    return Effect.map(sortArray(act, items, args[0], node), (sorted) => {
      // A comparator may have changed the graph since its elements were collected.
      // Validate every reinsertion before writing any of the sorted snapshot back.
      for (const item of sorted) rejectCircularInsertion(target, item, "Array.sort result", node);
      for (const [index, item] of sorted.entries()) target[index] = item;
      for (let index = sorted.length; index < length; index += 1) delete target[index];
      return target;
    });
  },
  toSorted: ({ act, target, args, node }) => sortArray(act, target, args[0], node),
  toReversed: ({ target }) => Effect.succeed([...target].reverse()),
  with: (call) => {
    const { target } = call;
    const index = optNumber(call, call.args[0], "index") ?? 0;
    const resolved = index < 0 ? target.length + index : index;
    if (resolved < 0 || resolved >= target.length) {
      throw new InterpreterRuntimeError("Array.with index is out of range.", call.node);
    }
    const copied = [...target];
    copied[resolved] = call.args[1];
    return Effect.succeed(copied);
  },
  push: ({ target, args, node }) => {
    // Validate before mutating (so no rollback is needed): inserting a container into
    // itself would create a cycle no later walk could survive.
    assertBoundedCollectionSize(target.length + args.length, "Array.push", node);
    for (const item of args) rejectCircularInsertion(target, item, "Array.push result", node);
    target.push(...args);
    return Effect.succeed(target.length);
  },
  unshift: ({ target, args, node }) => {
    assertBoundedCollectionSize(target.length + args.length, "Array.unshift", node);
    for (const item of args) rejectCircularInsertion(target, item, "Array.unshift result", node);
    target.unshift(...args);
    return Effect.succeed(target.length);
  },
  pop: ({ target }) => Effect.succeed(target.pop()),
  shift: ({ target }) => Effect.succeed(target.shift()),
  toSpliced: (call) => {
    const { target, args } = call;
    const length = target.length;
    const rawStart = optNumber(call, args[0], "start") ?? 0;
    const start = Number.isNaN(rawStart) ? 0 : Math.trunc(rawStart);
    const from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
    const rawDelete = optNumber(call, args[1], "delete count") ?? 0;
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
    assertBoundedCollectionSize(length - removed + inserted.length, "Array.toSpliced", call.node);
    const copied: InterpreterArray = [];
    // Read every retained index to densify holes. Avoid a native argument spread:
    // the collection cap is larger than engines' function-argument limits.
    for (let index = 0; index < from; index += 1) copied.push(target[index]);
    for (const item of inserted) copied.push(item);
    for (let index = from + removed; index < length; index += 1) copied.push(target[index]);
    return Effect.succeed(copied);
  },
  splice: (call) => {
    const { target, args, node } = call;
    // Mutates in place and returns the removed elements, exactly like JS: one argument
    // removes to the end, an undefined delete count removes nothing.
    if (args.length === 0) return Effect.succeed(target.splice(0, 0));
    const start = optNumber(call, args[0], "start") ?? 0;
    if (args.length === 1) return Effect.succeed(target.splice(start));
    const deleteCount = optNumber(call, args[1], "delete count") ?? 0;
    const inserted = args.slice(2);
    assertBoundedCollectionSize(target.length + inserted.length, "Array.splice", node);
    for (const item of inserted) rejectCircularInsertion(target, item, "Array.splice result", node);
    return Effect.succeed(target.splice(start, deleteCount, ...inserted));
  },
  fill: (call) => {
    rejectCircularInsertion(call.target, call.args[0], "Array.fill result", call.node);
    return Effect.succeed(
      call.target.fill(
        call.args[0],
        optNumber(call, call.args[1], "start"),
        optNumber(call, call.args[2], "end"),
      ),
    );
  },
  copyWithin: (call) =>
    Effect.succeed(
      call.target.copyWithin(
        optNumber(call, call.args[0], "target index") ?? 0,
        optNumber(call, call.args[1], "start") ?? 0,
        optNumber(call, call.args[2], "end"),
      ),
    ),
  keys: ({ target }) => Effect.sync(() => makeNativeIterator(target.keys(), "Array.keys entries")),
  values: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.values(), "Array.values entries")),
  entries: ({ target }) =>
    Effect.sync(() => makeNativeIterator(target.entries(), "Array.entries entries")),
  map: (call) => {
    const { length, present, call: visit } = iteration(call);
    return Effect.gen(function* () {
      const values: InterpreterArray = [];
      values.length = length;
      for (let index = 0; index < length; index += 1)
        if (present(index)) values[index] = yield* visit(call.target[index], index);
      return values;
    });
  },
  flatMap: (call) => {
    const { length, present, call: visit } = iteration(call);
    return Effect.gen(function* () {
      const values: InterpreterArray = [];
      for (let index = 0; index < length; index += 1) {
        if (!present(index)) continue;
        const mapped = yield* visit(call.target[index], index);
        if (!Array.isArray(mapped)) {
          assertBoundedCollectionSize(values.length + 1, "Array.flatMap", call.node);
          values.push(mapped);
          continue;
        }
        assertBoundedCollectionSize(values.length + mapped.length, "Array.flatMap", call.node);
        for (let inner = 0; inner < mapped.length; inner += 1)
          if (Object.hasOwn(mapped, inner)) values.push(mapped[inner]);
      }
      return values;
    });
  },
  filter: (call) => {
    const { length, present, call: visit } = iteration(call);
    return Effect.gen(function* () {
      const values: InterpreterArray = [];
      for (let index = 0; index < length; index += 1) {
        if (!present(index)) continue;
        const item = call.target[index];
        if (yield* visit(item, index)) values.push(item);
      }
      return values;
    });
  },
  find: (call) => {
    const { length, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = 0; index < length; index += 1) {
        const item = call.target[index];
        if (yield* visit(item, index)) return item;
      }
      return undefined;
    });
  },
  findIndex: (call) => {
    const { length, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = 0; index < length; index += 1)
        if (yield* visit(call.target[index], index)) return index;
      return -1;
    });
  },
  findLast: (call) => {
    const { length, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = length - 1; index >= 0; index -= 1) {
        const item = call.target[index];
        if (yield* visit(item, index)) return item;
      }
      return undefined;
    });
  },
  findLastIndex: (call) => {
    const { length, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = length - 1; index >= 0; index -= 1)
        if (yield* visit(call.target[index], index)) return index;
      return -1;
    });
  },
  some: (call) => {
    const { length, present, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = 0; index < length; index += 1)
        if (present(index) && (yield* visit(call.target[index], index))) return true;
      return false;
    });
  },
  every: (call) => {
    const { length, present, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = 0; index < length; index += 1)
        if (present(index) && !(yield* visit(call.target[index], index))) return false;
      return true;
    });
  },
  forEach: (call) => {
    const { length, present, call: visit } = iteration(call);
    return Effect.gen(function* () {
      for (let index = 0; index < length; index += 1)
        if (present(index)) yield* visit(call.target[index], index);
      return undefined;
    });
  },
  reduce: (call) => {
    const { length, present, apply } = iteration(call);
    const { target, args } = call;
    return Effect.gen(function* () {
      let index = 0;
      let accumulator: InterpreterValue;
      if (args.length >= 2) accumulator = args[1];
      else {
        while (index < length && !present(index)) index += 1;
        if (index >= length) throw emptyReduce(call);
        accumulator = target[index];
        index += 1;
      }
      for (; index < length; index += 1)
        if (present(index)) accumulator = yield* apply([accumulator, target[index], index, target]);
      return accumulator;
    });
  },
  reduceRight: (call) => {
    const { length, present, apply } = iteration(call);
    const { target, args } = call;
    return Effect.gen(function* () {
      let index = length - 1;
      let accumulator: InterpreterValue;
      if (args.length >= 2) accumulator = args[1];
      else {
        while (index >= 0 && !present(index)) index -= 1;
        if (index < 0) throw emptyReduce(call);
        accumulator = target[index];
        index -= 1;
      }
      for (; index >= 0; index -= 1)
        if (present(index)) accumulator = yield* apply([accumulator, target[index], index, target]);
      return accumulator;
    });
  },
});

export function invokeArrayMethod<R>(
  act: Activation<R>,
  target: InterpreterArray,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const method = arrayMethods.get(name);
  if (method === undefined)
    throw new InterpreterRuntimeError(`Array method '${name}' is not available in CodeMode.`, node);
  return method({ act, target, name, args, node });
}

export function sortArray<R>(
  act: Activation<R>,
  target: InterpreterArray,
  comparator: InterpreterValue,
  node: AstNode,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  if (comparator !== undefined && !isCallableReference(comparator)) {
    throw new InterpreterRuntimeError("Array.sort expects a function comparator.", node);
  }
  // Per spec, undefined elements sort to the end and are never compared.
  const defined = target.filter((item) => item !== undefined);
  const undefinedTail = Array.from({ length: target.length - defined.length }, () => undefined);
  if (comparator === undefined) {
    return Effect.sync(() => [
      ...defined.sort((a, b) => {
        const left = coerceToString(a);
        const right = coerceToString(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
      ...undefinedTail,
    ]);
  }
  const apply = applyCollectionCallback(act, comparator, "Array.sort", node);
  const mergeSort = (
    items: InterpreterArray,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R> => {
    if (items.length <= 1) return Effect.succeed(items);
    const midpoint = Math.floor(items.length / 2);
    return Effect.gen(function* () {
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
  return Effect.map(mergeSort(defined), (items) => [...items, ...undefinedTail]);
}
