import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/**
 * The first item the predicate accepts, or `undefined`: `Arr.findFirst` for callers that never
 * use the `Option`.
 */
export function findOrUndefined<A, B extends A>(
  items: Iterable<A>,
  refinement: (item: A, index: number) => item is B,
): B | undefined;
export function findOrUndefined<A>(
  items: Iterable<A>,
  predicate: (item: A, index: number) => boolean,
): A | undefined;
export function findOrUndefined<A>(
  items: Iterable<A>,
  predicate: (item: A, index: number) => boolean,
): A | undefined {
  return Option.getOrUndefined(Arr.findFirst(items, predicate));
}
