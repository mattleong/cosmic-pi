import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { invokeBytesStatic } from "../stdlib/bytes.js";
import { invokeBase64 } from "../stdlib/encoding.js";
import { dateStatics, invokeDateStatic } from "../stdlib/date.js";
import { invokeMathMethod } from "../stdlib/math.js";
import { invokeNumberStatic } from "../stdlib/number.js";
import { invokeObjectMethod } from "../stdlib/object.js";
import { invokeStringStatic } from "../stdlib/string.js";
import { invokeURLStatic } from "../stdlib/url.js";
import { boundedData } from "../stdlib/value.js";
import { SandboxMap, SandboxSet, SandboxURLSearchParams } from "../values.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import {
  type AstNode,
  GlobalMethodReference,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "./model.js";

// SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
export const invokeArrayStatic = (name: string, args: InterpreterArray, node: AstNode) => {
  switch (name) {
    case "isArray":
      return Array.isArray(args[0]);
    case "of":
      return [...args];
    case "from": {
      // Map/Set materialize directly (the data checkpoint would serialize them to {}).
      // Confinement preflight: the projected entry count is charged before any native
      // materialization allocates it.
      if (args[0] instanceof SandboxMap) {
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        assertBoundedCollectionSize((args[0] as SandboxMap).map.size, "Array.from result", node);
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        return Array.from((args[0] as SandboxMap).map.entries(), ([key, item]) => [key, item]);
      }
      if (args[0] instanceof SandboxSet) {
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        assertBoundedCollectionSize((args[0] as SandboxSet).set.size, "Array.from result", node);
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        return Array.from((args[0] as SandboxSet).set.values());
      }
      if (args[0] instanceof SandboxURLSearchParams) {
        assertBoundedCollectionSize(args[0].params.size, "Array.from result", node);
        return Array.from(args[0].params.entries(), ([key, value]) => [key, value]);
      }
      const source = boundedData(args[0], "Array.from input");
      if (Predicate.isString(source)) {
        assertBoundedCollectionSize(source.length, "Array.from result", node);
        return Array.from(source);
      }
      if (Array.isArray(source)) return [...source];
      if (
        source !== null &&
        hasObjectRuntimeType(source) &&
        // SAFETY: boundedData has validated this object; the optional property remains unknown until the number check.
        Predicate.isNumber((source as { length?: unknown }).length)
      ) {
        // Confinement preflight: an array-like's `length` is guest-controlled data, so the
        // projected allocation (ToLength semantics: NaN -> 0, negative -> 0, fractions
        // truncate; +Infinity stays over the cap) is charged before the native Array.from
        // call trusts it. `source` is the validated data copy, so the length the native call
        // re-reads is exactly the length charged here.
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        const rawLength = (source as { length: number }).length;
        const projected = Number.isNaN(rawLength) ? 0 : Math.max(0, Math.trunc(rawLength));
        assertBoundedCollectionSize(projected, "Array.from result", node);
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        return Array.from(source as ArrayLike<unknown>);
      }
      throw new InterpreterRuntimeError(
        "Array.from expects an array, string, Map, Set, or array-like value.",
        node,
      );
    }
    default:
      throw new InterpreterRuntimeError(`Array.${name} is not available in CodeMode.`, node);
  }
};

export const invokeGlobalMethod = (
  ref: GlobalMethodReference,
  args: InterpreterArray,
  node: AstNode,
) => {
  if (ref.namespace === "Uint8Array") return invokeBytesStatic(ref.name, args, node);
  if (ref.namespace === "Encoding" && (ref.name === "atob" || ref.name === "btoa"))
    return invokeBase64(ref.name, args, node);
  if (ref.namespace === "console")
    throw new InterpreterRuntimeError(`console.${ref.name} is not available in CodeMode.`, node);
  if (ref.namespace === "Object") return invokeObjectMethod(ref.name, args, node);
  if (ref.namespace === "Math") return invokeMathMethod(ref.name, args, node);
  if (ref.namespace === "Array") return invokeArrayStatic(ref.name, args, node);
  if (ref.namespace === "Number") return invokeNumberStatic(ref.name, args, node);
  if (ref.namespace === "String") return invokeStringStatic(ref.name, args, node);
  if (ref.namespace === "URL") return invokeURLStatic(ref.name, args, node);
  if (ref.namespace === "Date") {
    if (!dateStatics.has(ref.name))
      throw new InterpreterRuntimeError(`Date.${ref.name} is not available in CodeMode.`, node);
    return invokeDateStatic(ref.name, args, node);
  }
  if (
    ref.namespace === "RegExp" ||
    ref.namespace === "Map" ||
    ref.namespace === "Set" ||
    ref.namespace === "URLSearchParams"
  ) {
    throw new InterpreterRuntimeError(
      `${ref.namespace}.${ref.name} is not available in CodeMode.`,
      node,
    );
  }
  throw new InterpreterRuntimeError(
    `${ref.namespace}.${ref.name} is not available in CodeMode.`,
    node,
  );
};
