export const arrayMethods = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "includes",
  "join",
  "reduce",
  "reduceRight",
  "flatMap",
  "forEach",
  "sort",
  "toSorted",
  "slice",
  "concat",
  "indexOf",
  "lastIndexOf",
  "at",
  "flat",
  "reverse",
  "toReversed",
  "with",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "toSpliced",
  "fill",
  "copyWithin",
  "keys",
  "values",
  "entries",
]);

export const mapMethods = new Set([
  "get",
  "set",
  "has",
  "delete",
  "clear",
  "forEach",
  "keys",
  "values",
  "entries",
]);

export const setMethods = new Set([
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
  "add",
  "has",
  "delete",
  "clear",
  "forEach",
  "keys",
  "values",
  "entries",
]);

// Confinement preflight (local; see PROVENANCE.md deviation 8): the projected entry count is
// charged before the native materialization allocates it, so a long admitted string or a
// URLSearchParams parsed from a large URL query cannot materialize an over-cap array here.
export const spreadItems = (value: InterpreterValue): InterpreterArray | undefined => {
  if (Array.isArray(value)) return value;
  if (Predicate.isString(value)) {
    assertBoundedCollectionSize(value.length, "String spread");
    return Array.from(value);
  }
  if (value instanceof SandboxMap) {
    assertBoundedCollectionSize(value.map.size, "Map spread");
    return Array.from(value.map.entries(), ([key, item]) => [key, item]);
  }
  if (value instanceof SandboxSet) {
    assertBoundedCollectionSize(value.set.size, "Set spread");
    return Array.from(value.set.values());
  }
  if (value instanceof SandboxURLSearchParams) {
    assertBoundedCollectionSize(value.params.size, "URLSearchParams spread");
    return Array.from(value.params.entries(), ([key, item]) => [key, item]);
  }
  return undefined;
};
import * as Predicate from "effect/Predicate";

import { assertBoundedCollectionSize } from "../interpreter/confinement.js";
import { SandboxMap, SandboxSet, SandboxURLSearchParams } from "../values.js";

import type { InterpreterArray, InterpreterValue } from "../interpreter/model.js";
