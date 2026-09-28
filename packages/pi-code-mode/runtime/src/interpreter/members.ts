import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { byteMethods } from "../stdlib/bytes.js";
import { dateMethods } from "../stdlib/date.js";
import { mathConstant, mathConstants } from "../stdlib/math.js";
import { numberConstant, numberConstants, numberMethods, numberStatics } from "../stdlib/number.js";
import { promiseStatics } from "../stdlib/promise.js";
import { regexpMethods, regexpProperties, regexpProperty } from "../stdlib/regexp.js";
import { stringStatics } from "../stdlib/string.js";
import { readUrlProperty, urlMethods, urlProperties } from "../stdlib/url.js";
import { extendToolPath } from "../tool-tree.js";
import {
  SandboxBytes,
  SandboxTextEncoder,
  SandboxTextDecoder,
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
  GeneratorReference,
  GuestIterator,
  GuestAsyncIterator,
  type GuestPropertyKey,
  CoercionFunction,
  ComputedValue,
  getBoolean,
  getNode,
  getString,
  GlobalMethodReference,
  GlobalNamespace,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  IntrinsicReference,
  type MemberReference,
  OptionalShortCircuit,
  type PromiseMethodName,
  PromiseMethodReference,
  PromiseNamespace,
  ToolReference,
} from "./model.js";
import { toPropertyKey } from "./conversions.js";
import { isDataKeyOf, isBlockedMember } from "../tool-runtime-data.js";
import { nativeIteratorHelpers, isNativeIterator } from "./iterator-protocol.js";
import { hasGlobalStatic } from "./globals.js";
import { evaluateExpression } from "./expressions.js";
import { type Activation } from "./activation.js";
import { isRuntimeReference } from "./references.js";
import { stringMethods } from "./string-operations.js";
import { mapMethods, setMethods, urlSearchParamsMethods } from "./iteration.js";
import { arrayMethods } from "./array-methods.js";
export const deferredAccessErrors = new WeakMap<ComputedValue, InterpreterRuntimeError>();

export function getMemberReference<R>(
  act: Activation<R>,
  node: AstNode,
  deferInvalidBase = false,
): Effect.Effect<
  | MemberReference
  | ToolReference
  | PromiseMethodReference
  | IntrinsicReference
  | GlobalMethodReference
  | ComputedValue
  | typeof OptionalShortCircuit
  | undefined,
  RuntimeFailure,
  R
> {
  const objectNode = getNode(node, "object");
  const propertyNode = getNode(node, "property");
  const computed = getBoolean(node, "computed");
  const optional = node.optional === true;
  return Effect.gen(function* () {
    const objectValue = yield* evaluateExpression(act, objectNode);
    if (objectValue === OptionalShortCircuit) return OptionalShortCircuit;
    if ((objectValue === null || objectValue === undefined) && optional)
      return OptionalShortCircuit;

    const key = computed
      ? toPropertyKey(yield* evaluateExpression(act, propertyNode), propertyNode)
      : propertyNode.type === "Identifier"
        ? getString(propertyNode, "name")
        : toPropertyKey(yield* evaluateExpression(act, propertyNode), propertyNode);

    return resolveMember(objectValue, key, {
      objectNode,
      propertyNode,
      computed,
      deferInvalidBase,
    });
  });
}

/** Where a member access appears, for diagnostics and deferred base errors. */
interface MemberSite {
  readonly objectNode: AstNode;
  readonly propertyNode: AstNode;
  readonly computed: boolean;
  readonly deferInvalidBase: boolean;
}

export type ResolvedMember =
  | MemberReference
  | ToolReference
  | PromiseMethodReference
  | IntrinsicReference
  | GlobalMethodReference
  | ComputedValue;

/** Resolves one property of an evaluated value: a readable/writable slot, or a runtime reference. */
const resolveMember = (
  objectValue: InterpreterValue,
  key: GuestPropertyKey,
  { objectNode, propertyNode, computed, deferInvalidBase }: MemberSite,
): ResolvedMember => {
  if (objectValue instanceof ToolReference) {
    if (!Predicate.isString(key) || isBlockedMember(key)) {
      throw new InterpreterRuntimeError(
        "Tool paths must use safe string property names.",
        propertyNode,
      );
    }
    return objectValue.child(key, () => extendToolPath(objectValue.path, key));
  }

  if (objectValue instanceof PromiseNamespace) {
    // SAFETY: Set membership is tested with the string key; a miss is refused below.
    if (Predicate.isString(key) && promiseStatics.has(key as PromiseMethodName)) {
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return new PromiseMethodReference(key as PromiseMethodName);
    }
    throw new InterpreterRuntimeError(
      `Promise.${String(key)} is not available in CodeMode. Available: Promise.all, Promise.allSettled, Promise.any, Promise.race, Promise.resolve, and Promise.reject; consume promises with await or then/catch/finally.`,
      propertyNode,
    );
  }

  if (objectValue instanceof GeneratorReference) {
    if (Predicate.isString(key) && isBlockedMember(key))
      throw new InterpreterRuntimeError(
        `Property '${key}' is not available in CodeMode.`,
        propertyNode,
      );
    if (key === "next" || key === "return" || key === "throw")
      return new IntrinsicReference(objectValue, key);
    if (key === GuestIterator && !objectValue.async)
      return new IntrinsicReference(objectValue, "iterator");
    if (key === GuestAsyncIterator && objectValue.async)
      return new IntrinsicReference(objectValue, "asyncIterator");
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof GlobalNamespace && objectValue.name === "Symbol") {
    if (key === "iterator") return new ComputedValue(GuestIterator);
    if (key === "asyncIterator") return new ComputedValue(GuestAsyncIterator);
    return new ComputedValue(undefined);
  }
  if (
    key === GuestIterator &&
    (Array.isArray(objectValue) ||
      Predicate.isString(objectValue) ||
      objectValue instanceof SandboxBytes ||
      objectValue instanceof SandboxMap ||
      objectValue instanceof SandboxSet ||
      objectValue instanceof SandboxURLSearchParams)
  )
    return new IntrinsicReference(objectValue, "iterator");

  if (objectValue instanceof GlobalNamespace) {
    if (!Predicate.isString(key) || isBlockedMember(key)) {
      throw new InterpreterRuntimeError(
        `${objectValue.name}.${String(key)} is not available in CodeMode.`,
        propertyNode,
      );
    }
    if (objectValue.name === "Math" && mathConstants.has(key)) {
      return new ComputedValue(mathConstant(key));
    }
    return hasGlobalStatic(objectValue.name, key)
      ? new GlobalMethodReference(objectValue.name, key)
      : new ComputedValue(undefined);
  }

  if (Predicate.isString(objectValue)) {
    if (key === "length") return new ComputedValue(objectValue.length);
    if (Predicate.isNumber(key)) return new ComputedValue(objectValue[key]);
    if (Predicate.isString(key) && isArrayIndexKey(key))
      return new ComputedValue(objectValue[Number(key)]);
    if (Predicate.isString(key) && stringMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    // Unknown property on a string reads as `undefined`, matching JS (`"x".foo === undefined`),
    // instead of throwing - so defensive access like `result?.login ?? result` on a JSON-string
    // tool result doesn't crash. (Optional chaining only guards null/undefined receivers, so a
    // real string still reaches here.) Only the method allowlist above yields callables.
    return new ComputedValue(undefined);
  }

  if (Predicate.isNumber(objectValue)) {
    if (Predicate.isString(key) && numberMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    // Unknown property on a number reads as `undefined`, matching JS, rather than throwing.
    return new ComputedValue(undefined);
  }

  // Number / String expose a small allowlist of statics; everything else stays opaque.
  if (objectValue instanceof CoercionFunction && Predicate.isString(key) && !isBlockedMember(key)) {
    if (objectValue.name === "Number" && numberConstants.has(key)) {
      return new ComputedValue(numberConstant(key));
    }
    if (objectValue.name === "Number" && numberStatics.has(key))
      return new GlobalMethodReference("Number", key);
    if (objectValue.name === "String" && stringStatics.has(key))
      return new GlobalMethodReference("String", key);
  }

  // Sandbox value types expose their method/property allowlists; any other key reads as
  // `undefined`, consistent with unknown-property reads on strings/numbers/arrays.
  if (objectValue instanceof SandboxBytes) {
    if (key === "length" || key === "byteLength") return new ComputedValue(objectValue.length);
    if (Predicate.isString(key) && byteMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    if (
      Predicate.isNumber(key) ||
      (Predicate.isString(key) && (key === "-0" || String(Number(key)) === key))
    )
      return { target: objectValue, key };
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxTextEncoder || objectValue instanceof SandboxTextDecoder) {
    if (key === "encoding") return new ComputedValue("utf-8");
    if (objectValue instanceof SandboxTextDecoder && (key === "fatal" || key === "ignoreBOM"))
      return new ComputedValue(objectValue[key]);
    if (
      (objectValue instanceof SandboxTextEncoder && key === "encode") ||
      (objectValue instanceof SandboxTextDecoder && key === "decode")
    )
      return new IntrinsicReference(objectValue, key);
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxDate) {
    if (Predicate.isString(key) && dateMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxRegExp) {
    // lastIndex is the one writable RegExp field, so `re.lastIndex = 0` resets a /g cursor.
    if (key === "lastIndex") return { target: objectValue, key };
    if (Predicate.isString(key) && regexpProperties.has(key)) {
      return new ComputedValue(regexpProperty(objectValue, key));
    }
    if (Predicate.isString(key) && regexpMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxMap) {
    if (key === "size") return new ComputedValue(objectValue.map.size);
    if (Predicate.isString(key) && mapMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxSet) {
    if (key === "size") return new ComputedValue(objectValue.set.size);
    if (Predicate.isString(key) && setMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxURL) {
    if (key === "searchParams") {
      return new ComputedValue(objectValue.searchParams);
    }
    if (Predicate.isString(key) && urlMethods.has(key))
      return new IntrinsicReference(objectValue, key);
    if (Predicate.isString(key) && urlProperties.has(key)) return { target: objectValue, key };
    return new ComputedValue(undefined);
  }
  if (objectValue instanceof SandboxURLSearchParams) {
    if (key === "size") return new ComputedValue(objectValue.params.size);
    if (Predicate.isString(key) && urlSearchParamsMethods.has(key)) {
      return new IntrinsicReference(objectValue, key);
    }
    return new ComputedValue(undefined);
  }

  // Expose only confined reactions. Other reads retain the missing-await diagnostic.
  if (objectValue instanceof SandboxPromise) {
    if (key === "then" || key === "catch" || key === "finally") {
      return new IntrinsicReference(objectValue, key);
    }
    throw new InterpreterRuntimeError(
      "This value is an un-awaited Promise and has no readable properties; await it first - e.g. `const result = await tools.ns.tool(...)`.",
      objectNode,
      "InvalidDataValue",
    );
  }

  if (isRuntimeReference(objectValue)) {
    throw new InterpreterRuntimeError(
      "CodeMode runtime references are opaque and do not expose properties.",
      objectNode,
      "InvalidDataValue",
    );
  }

  if (!hasObjectRuntimeType(objectValue) || objectValue === null) {
    // Only a literal property name is named; computed keys may carry program data.
    const property = !computed && Predicate.isString(key) ? ` '${key}'` : "";
    const base =
      objectValue === null || objectValue === undefined
        ? String(objectValue)
        : Predicate.isBoolean(objectValue)
          ? "a boolean"
          : "a primitive value";
    const error = new InterpreterRuntimeError(
      `Cannot access property${property} of ${base}.`,
      objectNode,
    ).as("TypeError");
    if (!deferInvalidBase) throw error;
    const reference = new ComputedValue(undefined);
    deferredAccessErrors.set(reference, error);
    return reference;
  }

  if (!isDataKeyOf(objectValue, key)) {
    throw new InterpreterRuntimeError(
      `Property '${String(key)}' is not available in CodeMode.`,
      propertyNode,
    );
  }

  if (Array.isArray(objectValue)) {
    if (
      key !== "length" &&
      !(Predicate.isString(key) && arrayMethods.has(key)) &&
      !Predicate.isNumber(key) &&
      !(Predicate.isString(key) && isArrayIndexKey(key))
    ) {
      // Own non-index properties read through (match results carry index/groups); like JS,
      // they are readable in place and dropped by JSON at data boundaries.
      if (key === "index") return new ComputedValue(objectValue.index);
      if (key === "input") return new ComputedValue(objectValue.input);
      if (key === "groups") return new ComputedValue(objectValue.groups);
      // Unknown property on an array reads as `undefined`, matching JS (`[1,2].foo === undefined`),
      // instead of throwing - so defensive access under optional chaining behaves as expected.
      return new ComputedValue(undefined);
    }
    return { target: objectValue, key };
  }

  // SAFETY: The preceding variant checks establish the narrowed runtime representation used here.
  return { target: objectValue as InterpreterObject, key };
};

export function readMember<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.map(getMemberReference(act, node), (reference) =>
    reference === OptionalShortCircuit || reference === undefined
      ? reference
      : readReference(reference),
  );
}

/** Reads `value[key]` with the same rules as a member expression. */
export const readProperty = (
  value: InterpreterValue,
  key: GuestPropertyKey,
  node: AstNode,
): InterpreterValue =>
  readReference(
    resolveMember(value, key, {
      objectNode: node,
      propertyNode: node,
      computed: true,
      deferInvalidBase: false,
    }),
  );

/**
 * `key in value`: true for own data members and for every member a member expression would
 * find (collection methods, `size`, URL properties), never for internal fields.
 */
export const hasProperty = (
  value: InterpreterValue,
  key: GuestPropertyKey,
  node: AstNode,
): boolean => {
  if (value === null || !hasObjectRuntimeType(value))
    throw new InterpreterRuntimeError(
      "The 'in' operator requires an object on the right-hand side.",
      node,
    ).as("TypeError");
  const reference = resolveMember(value, key, {
    objectNode: node,
    propertyNode: node,
    computed: true,
    deferInvalidBase: false,
  });
  if (reference instanceof ComputedValue) return reference.value !== undefined;
  if (
    reference instanceof ToolReference ||
    reference instanceof PromiseMethodReference ||
    reference instanceof IntrinsicReference ||
    reference instanceof GlobalMethodReference
  )
    return true;
  const { target } = reference;
  if (target instanceof SandboxURL || target instanceof SandboxRegExp) return true;
  if (target instanceof SandboxBytes) {
    const index = Number(reference.key);
    return Number.isInteger(index) && index >= 0 && index < target.length;
  }
  if (Array.isArray(target))
    return (
      reference.key === "length" ||
      (Predicate.isString(reference.key) && arrayMethods.has(reference.key)) ||
      Object.hasOwn(target, reference.key)
    );
  return (
    Object.hasOwn(target, reference.key) ||
    objectIntrinsics.has(reference.key) ||
    (Predicate.isString(reference.key) &&
      nativeIteratorHelpers.has(reference.key) &&
      isNativeIterator(target))
  );
};

export const readReference = (reference: ResolvedMember): InterpreterValue => {
  if (reference instanceof ComputedValue) return reference.value;
  if (
    reference instanceof ToolReference ||
    reference instanceof PromiseMethodReference ||
    reference instanceof IntrinsicReference ||
    reference instanceof GlobalMethodReference
  )
    return reference;
  if (Array.isArray(reference.target)) {
    if (Predicate.isString(reference.key) && arrayMethods.has(reference.key)) {
      return new IntrinsicReference(reference.target, reference.key);
    }
    return reference.key === "length"
      ? reference.target.length
      : reference.target[Number(reference.key)];
  }
  if (reference.target instanceof SandboxBytes)
    return reference.target.storage()[reference.key === "-0" ? Number.NaN : Number(reference.key)];
  if (reference.target instanceof SandboxURL)
    return readUrlProperty(reference.target, String(reference.key));
  if (reference.target instanceof SandboxRegExp) return reference.target.regex.lastIndex;
  // Guest objects have no prototype; reading own properties only keeps any object that
  // does carry one from exposing inherited host methods.
  if (Object.hasOwn(reference.target, reference.key)) return reference.target[reference.key];
  if (
    Predicate.isString(reference.key) &&
    nativeIteratorHelpers.has(reference.key) &&
    isNativeIterator(reference.target)
  )
    return new IntrinsicReference(reference.target, reference.key);
  return objectIntrinsics.has(reference.key)
    ? new IntrinsicReference(reference.target, String(reference.key))
    : undefined;
};

/** A canonical array index string: `"0"` or digits without a leading zero. */
const isArrayIndexKey = (key: string): boolean => /^(?:0|[1-9]\d*)$/.test(key);

/** Methods every guest object answers to unless it has an own property of the same name. */
const objectIntrinsics = new Set<GuestPropertyKey>(["toString", "hasOwnProperty"]);
