import { hasObjectRuntimeType } from "../runtime-values.js";
import { assertBoundedCollectionSize } from "../interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  InterpreterRuntimeError,
  makeInterpreterObject,
} from "../interpreter/model.js";
import { isSandboxValue, SandboxMap, SandboxURLSearchParams } from "../values.js";
import { boundedData } from "./value.js";
import { coerceToString } from "../interpreter/conversions.js";
import { isDataKeyOf } from "../tool-runtime-data.js";
import { isNativeIterator } from "../interpreter/iterator-protocol.js";

export const objectStatics = new Set([
  "keys",
  "values",
  "entries",
  "hasOwn",
  "assign",
  "fromEntries",
  "groupBy",
]);

// Object helpers are shallow, as in JS: they check the container and take members by identity,
// so objects holding promises, functions, or nested collections work like any object literal.
const requireDataContainer = (
  value: InterpreterValue,
  label: string,
  node: AstNode,
): InterpreterObject | InterpreterArray => {
  if (
    value === null ||
    !hasObjectRuntimeType(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== null &&
      Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    throw new InterpreterRuntimeError(`${label} expects a data object or array.`, node);
  }
  // SAFETY: Only arrays and plain data objects pass the checkpoint and prototype checks.
  return value as InterpreterObject | InterpreterArray;
};

const ownDataMember = (
  value: InterpreterObject | InterpreterArray,
  key: string,
): InterpreterValue => {
  // SAFETY: Own data members of interpreter arrays and objects belong to InterpreterValue.
  return (value as InterpreterObject)[key];
};

const ownDataEntries = (
  value: InterpreterObject | InterpreterArray,
  label: string,
  node: AstNode,
): string[] => {
  // Arrays list index keys only, omitting match-result metadata such as index and groups.
  const keys = Array.isArray(value)
    ? Object.keys(value).filter((key) => /^(?:0|[1-9]\d*)$/.test(key))
    : Object.keys(value);
  assertBoundedCollectionSize(keys.length, label, node);
  return keys;
};

// The interpreter must supply its guarded member-write path. Never mutate directly here.
export const invokeObjectAssign = (
  args: InterpreterArray,
  node: AstNode,
  write: (
    target: InterpreterObject | InterpreterArray,
    key: string,
    value: InterpreterValue,
  ) => void,
): InterpreterObject | InterpreterArray => {
  const target = requireDataContainer(args[0], "Object.assign target", node);
  ownDataEntries(target, "Object.assign target", node);
  // Count symbol slots too, matching ordinary member assignment's growth guard.
  let entries = Reflect.ownKeys(target).length;
  for (const source of args.slice(1)) {
    if (source === null || source === undefined) continue;
    if (isSandboxValue(source)) {
      boundedData(source, "Object.assign input");
      continue;
    }
    const value = requireDataContainer(source, "Object.assign input", node);
    const keys = ownDataEntries(value, "Object.assign input", node);
    for (const key of keys) {
      if (!isDataKeyOf(target, key))
        throw new InterpreterRuntimeError(`Property '${key}' is not available in CodeMode.`, node);
      if (Array.isArray(target)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || String(index) !== key) {
          throw new InterpreterRuntimeError(
            "Object.assign array targets only support numeric index properties.",
            node,
          );
        }
        assertBoundedCollectionSize(index + 1, "Object.assign result", node);
      }
      if (!Object.hasOwn(target, key)) {
        assertBoundedCollectionSize(entries + 1, "Object.assign result", node);
        entries += 1;
      }
      write(target, key, ownDataMember(value, key));
    }
  }
  return target;
};

export function invokeObjectMethod(
  name: "fromEntries",
  args: InterpreterArray,
  node: AstNode,
): InterpreterObject;
export function invokeObjectMethod(
  name: string,
  args: InterpreterArray,
  node: AstNode,
): InterpreterValue;
export function invokeObjectMethod(
  name: string,
  args: InterpreterArray,
  node: AstNode,
): InterpreterValue {
  if (!objectStatics.has(name))
    throw new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node);
  const requireObject = (): InterpreterObject | InterpreterArray => {
    const value = args[0];
    // Collections and iterators have no own data members.
    if (isSandboxValue(value) || isNativeIterator(value)) return makeInterpreterObject();
    return requireDataContainer(value, `Object.${name} input`, node);
  };
  // Confinement: merging multiple sources (each individually within the entry cap) must not
  // materialize an over-cap object; distinct-key growth is counted and refused as it happens.
  let outEntries = 0;
  const guardedSet = (out: InterpreterObject, key: string, item: InterpreterValue): void => {
    if (!isDataKeyOf(out, key))
      throw new InterpreterRuntimeError(`Property '${key}' is not available in CodeMode.`, node);
    if (!Object.hasOwn(out, key)) {
      outEntries += 1;
      assertBoundedCollectionSize(outEntries, `Object.${name} result`, node);
    }
    out[key] = item;
  };
  switch (name) {
    case "keys":
      return ownDataEntries(requireObject(), "Object.keys input", node);
    case "values": {
      const value = requireObject();
      return ownDataEntries(value, "Object.values input", node).map(
        (key): InterpreterValue => ownDataMember(value, key),
      );
    }
    case "entries": {
      const value = requireObject();
      return ownDataEntries(value, "Object.entries input", node).map(
        (key): InterpreterArray => [key, ownDataMember(value, key)],
      );
    }
    case "hasOwn":
      return Object.hasOwn(requireObject(), String(args[1]));
    case "fromEntries": {
      if (args[0] instanceof SandboxMap) {
        const out: InterpreterObject = makeInterpreterObject();
        for (const [key, item] of args[0].map.entries()) guardedSet(out, coerceToString(key), item);
        return out;
      }
      if (args[0] instanceof SandboxURLSearchParams) {
        const out: InterpreterObject = makeInterpreterObject();
        for (const [key, value] of args[0].params.entries()) guardedSet(out, key, value);
        return out;
      }
      const pairs = args[0];
      if (!Array.isArray(pairs)) {
        throw new InterpreterRuntimeError(
          "Object.fromEntries expects an array of [key, value] pairs.",
          node,
        );
      }
      const out: InterpreterObject = makeInterpreterObject();
      for (const pair of pairs) {
        if (!Array.isArray(pair)) {
          throw new InterpreterRuntimeError("Object.fromEntries expects [key, value] pairs.", node);
        }
        guardedSet(out, coerceToString(pair[0]), pair[1]);
      }
      return out;
    }
  }
  throw new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node);
}
