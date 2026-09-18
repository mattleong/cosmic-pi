import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType, runtimeTypeName } from "../runtime-values.js";
import { errorBrandName } from "../stdlib/value.js";
import { ToolReference } from "../tool-runtime.js";
import {
  isSandboxValue,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import {
  type AstNode,
  CodeModeFunction,
  GeneratorReference,
  CoercionFunction,
  ErrorConstructorReference,
  GlobalMethodReference,
  GlobalNamespace,
  InterpreterRuntimeError,
  type InterpreterValue,
  IntrinsicReference,
  PromiseMethodReference,
  PromiseNamespace,
  UriFunction,
} from "./model.js";

export const isRuntimeReference = (value: InterpreterValue): boolean =>
  value instanceof GeneratorReference ||
  Predicate.isSymbol(value) ||
  value instanceof CodeModeFunction ||
  value instanceof ToolReference ||
  value instanceof IntrinsicReference ||
  value instanceof GlobalNamespace ||
  value instanceof GlobalMethodReference ||
  value instanceof PromiseNamespace ||
  value instanceof PromiseMethodReference ||
  value instanceof SandboxPromise ||
  value instanceof CoercionFunction ||
  value instanceof UriFunction ||
  value instanceof ErrorConstructorReference ||
  isSandboxValue(value);

export const containsRuntimeReference = (
  value: InterpreterValue,
  seen = new Set<object>(),
): boolean => {
  if (isRuntimeReference(value)) return true;
  if (value === null || !hasObjectRuntimeType(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const contains = Array.isArray(value)
    ? value.some((item) => containsRuntimeReference(item, seen))
    : Object.values(value).some((item) => containsRuntimeReference(item, seen));
  seen.delete(value);
  return contains;
};

// Like containsRuntimeReference, but sandbox standard-library values count as data:
// operators and switch treat them as ordinary object operands (identity equality, ToPrimitive
// coercion) rather than rejecting them as opaque interpreter machinery.
export const containsOpaqueReference = (
  value: InterpreterValue,
  seen = new Set<object>(),
): boolean => {
  if (isSandboxValue(value)) return false;
  if (isRuntimeReference(value)) return true;
  if (value === null || !hasObjectRuntimeType(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const contains = Array.isArray(value)
    ? value.some((item) => containsOpaqueReference(item, seen))
    : Object.values(value).some((item) => containsOpaqueReference(item, seen));
  seen.delete(value);
  return contains;
};

// `typeof` never throws in JS; map every interpreter value to its JS-visible category.
// A SandboxPromise falls through to the final `typeof value` and reports "object", exactly
// like a real JS promise.
export const typeofValue = (value: InterpreterValue): string => {
  if (
    value instanceof CodeModeFunction ||
    value instanceof CoercionFunction ||
    value instanceof IntrinsicReference ||
    value instanceof GlobalMethodReference ||
    value instanceof PromiseMethodReference ||
    value instanceof PromiseNamespace ||
    value instanceof ErrorConstructorReference
  )
    return "function";
  if (value instanceof UriFunction) return "function";
  if (value instanceof ToolReference) return value.path.length > 0 ? "function" : "object";
  if (value instanceof GlobalNamespace) {
    return value.name === "Math" || value.name === "JSON" || value.name === "console"
      ? "object"
      : "function";
  }
  return runtimeTypeName(value);
};

// `x instanceof C` against the constructors CodeMode knows. Like `typeof`, it observes any
// left-hand value (opaque references included) without coercing it. Error checks use the
// error brand: `instanceof Error` accepts every branded error; a specific error type matches
// its own brand only (as in JS, where TypeError instances are also Error instances).
export const instanceofValue = (
  lhs: InterpreterValue,
  rhs: InterpreterValue,
  node: AstNode,
): boolean => {
  if (rhs instanceof ErrorConstructorReference) {
    const brand = errorBrandName(lhs);
    return brand !== undefined && (rhs.name === "Error" || brand === rhs.name);
  }
  if (rhs instanceof GlobalNamespace) {
    switch (rhs.name) {
      case "Date":
        return lhs instanceof SandboxDate;
      case "RegExp":
        return lhs instanceof SandboxRegExp;
      case "Map":
        return lhs instanceof SandboxMap;
      case "Set":
        return lhs instanceof SandboxSet;
      case "URL":
        return lhs instanceof SandboxURL;
      case "URLSearchParams":
        return lhs instanceof SandboxURLSearchParams;
      case "Array":
        return Array.isArray(lhs);
      case "Object":
        return lhs !== null && (hasObjectRuntimeType(lhs) || typeofValue(lhs) === "function");
    }
  }
  if (rhs instanceof PromiseNamespace) return lhs instanceof SandboxPromise;
  // Number/String/Boolean wrap primitives in JS; no boxed values exist in CodeMode, so
  // `x instanceof Number` is always false - exactly what it is for primitives in JS.
  if (
    rhs instanceof CoercionFunction &&
    (rhs.name === "Number" || rhs.name === "String" || rhs.name === "Boolean")
  ) {
    return false;
  }
  throw new InterpreterRuntimeError(
    "The right-hand side of 'instanceof' must be a constructor CodeMode knows: Error (or a specific error type like TypeError), Date, RegExp, Map, Set, URL, URLSearchParams, Array, Object, or Promise.",
    node,
  );
};
