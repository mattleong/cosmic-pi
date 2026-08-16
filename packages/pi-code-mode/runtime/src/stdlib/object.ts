import { hasObjectRuntimeType } from "../runtime-values.ts";
import { assertBoundedCollectionSize } from "../interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  InterpreterRuntimeError,
  makeInterpreterObject,
} from "../interpreter/model.js";
import { isBlockedMember } from "../tool-runtime.js";
import { isSandboxValue, SandboxMap, SandboxURLSearchParams } from "../values.js";
import { boundedData, coerceToString } from "./value.js";

export const objectStatics = new Set([
  "keys",
  "values",
  "entries",
  "hasOwn",
  "assign",
  "fromEntries",
]);

export const invokeObjectMethod = (name: string, args: InterpreterArray, node: AstNode) => {
  if (!objectStatics.has(name))
    throw new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node);
  const requireObject = (): InterpreterObject => {
    const value = boundedData(args[0], `Object.${name} input`);
    if (isSandboxValue(value)) return {};
    if (value === null || !hasObjectRuntimeType(value) || Array.isArray(value)) {
      throw new InterpreterRuntimeError(`Object.${name} expects a data object.`, node);
    }
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    return value as InterpreterObject;
  };
  // Confinement: merging multiple sources (each individually within the entry cap) must not
  // materialize an over-cap object; distinct-key growth is counted and refused as it happens.
  let outEntries = 0;
  const guardedSet = (out: InterpreterObject, key: string, item: InterpreterValue): void => {
    if (isBlockedMember(key))
      throw new InterpreterRuntimeError(`Property '${key}' is not available in CodeMode.`, node);
    if (!Object.hasOwn(out, key)) {
      outEntries += 1;
      assertBoundedCollectionSize(outEntries, `Object.${name} result`, node);
    }
    out[key] = item;
  };
  switch (name) {
    case "keys": {
      const value = boundedData(args[0], "Object.keys input");
      if (isSandboxValue(value)) return [];
      if (Array.isArray(value)) return Object.keys(value);
      if (value === null || !hasObjectRuntimeType(value)) {
        throw new InterpreterRuntimeError("Object.keys expects a data object or array.", node);
      }
      return Object.keys(value);
    }
    case "values":
      return Object.values(requireObject());
    case "entries":
      return Object.entries(requireObject()).map(([key, item]) => [key, item]);
    case "hasOwn":
      return Object.hasOwn(requireObject(), String(args[1]));
    case "assign": {
      const out: InterpreterObject = makeInterpreterObject();
      for (const source of args) {
        if (source === null || source === undefined) continue;
        const value = boundedData(source, "Object.assign input");
        if (isSandboxValue(value)) continue;
        if (value === null || !hasObjectRuntimeType(value) || Array.isArray(value)) {
          throw new InterpreterRuntimeError("Object.assign expects data objects.", node);
        }
        for (const [key, item] of Object.entries(value)) guardedSet(out, key, item);
      }
      return out;
    }
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
      const pairs = boundedData(args[0], "Object.fromEntries input");
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
        guardedSet(out, String(pair[0]), pair[1]);
      }
      return out;
    }
  }
  throw new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node);
};
