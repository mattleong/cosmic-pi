import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { arrayMethods, mapMethods, setMethods } from "../stdlib/collections.js";
import { byteMethods, byteNumber } from "../stdlib/bytes.js";
import { dateMethods } from "../stdlib/date.js";
import { mathConstant, mathConstants } from "../stdlib/math.js";
import { numberConstant, numberConstants, numberMethods, numberStatics } from "../stdlib/number.js";
import { promiseStatics } from "../stdlib/promise.js";
import { regexpMethods, regexpProperties, regexpProperty } from "../stdlib/regexp.js";
import { stringMethods, stringStatics } from "../stdlib/string.js";
import {
  readUrlProperty,
  uriArgument,
  urlMethods,
  urlProperties,
  urlSearchParamsMethods,
  urlWritableProperties,
  writeUrlProperty,
} from "../stdlib/url.js";
import { isBlockedMember, ToolReference, ToolRuntimeError } from "../tool-runtime.js";
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
  assertBoundedCollectionSize,
  assertBoundedQueryPairs,
  assertBoundedStringLength,
  assertBoundedUrlQueryPairs,
  uriEncodedLengthUpperBound,
} from "./confinement.js";
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
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  IntrinsicReference,
  type MemberReference,
  OptionalShortCircuit,
  type PromiseMethodName,
  PromiseMethodReference,
  PromiseNamespace,
} from "./model.js";
import { isRuntimeReference } from "./runtime.js";
const deferredAccessErrors = new WeakMap<ComputedValue, InterpreterRuntimeError>();
export interface MembersHost<R> {
  assignToReference(
    reference: MemberReference,
    key: GuestPropertyKey,
    next: InterpreterValue,
    node: AstNode,
  ): void;
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  getMemberReference(
    node: AstNode,
    deferInvalidBase?: boolean,
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
  >;
  modifyMember(
    node: AstNode,
    compute: (
      current: InterpreterValue,
    ) => Effect.Effect<
      { write: boolean; next: InterpreterValue; result: InterpreterValue },
      RuntimeFailure,
      R
    >,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  rejectCircularInsertion(
    container: InterpreterObject | InterpreterArray,
    value: InterpreterValue,
    label: string,
    node: AstNode,
    seen?: Set<object>,
  ): void;
  toPropertyKey(value: InterpreterValue, node: AstNode): GuestPropertyKey;
}

export function getMemberReference<R>(
  this: MembersHost<R>,
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
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  return Effect.gen({ self: this }, function* () {
    const objectValue = yield* this.evaluateExpression(objectNode);
    if (objectValue === OptionalShortCircuit) return OptionalShortCircuit;
    if ((objectValue === null || objectValue === undefined) && optional)
      return OptionalShortCircuit;

    const key = computed
      ? this.toPropertyKey(yield* this.evaluateExpression(propertyNode), propertyNode)
      : propertyNode.type === "Identifier"
        ? getString(propertyNode, "name")
        : this.toPropertyKey(yield* this.evaluateExpression(propertyNode), propertyNode);

    if (objectValue instanceof ToolReference) {
      if (!Predicate.isString(key) || isBlockedMember(key)) {
        throw new InterpreterRuntimeError(
          "Tool paths must use safe string property names.",
          propertyNode,
        );
      }
      return new ToolReference([...objectValue.path, key]);
    }

    if (objectValue instanceof PromiseNamespace) {
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
      return new GlobalMethodReference(objectValue.name, key);
    }

    if (Predicate.isString(objectValue)) {
      if (key === "length") return new ComputedValue(objectValue.length);
      if (Predicate.isNumber(key)) return new ComputedValue(objectValue[key]);
      if (Predicate.isString(key) && /^\d+$/.test(key))
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
    if (
      objectValue instanceof CoercionFunction &&
      Predicate.isString(key) &&
      !isBlockedMember(key)
    ) {
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
      const error = new InterpreterRuntimeError(
        "Cannot access a property on a non-object value.",
        objectNode,
      ).as("TypeError");
      if (!deferInvalidBase) throw error;
      const reference = new ComputedValue(undefined);
      deferredAccessErrors.set(reference, error);
      return reference;
    }

    if (Predicate.isString(key) && isBlockedMember(key)) {
      throw new InterpreterRuntimeError(
        `Property '${key}' is not available in CodeMode.`,
        propertyNode,
      );
    }

    if (Array.isArray(objectValue)) {
      if (
        key !== "length" &&
        !(Predicate.isString(key) && arrayMethods.has(key)) &&
        !Predicate.isNumber(key) &&
        !(Predicate.isString(key) && /^\d+$/.test(key))
      ) {
        // Own non-index properties read through (match results carry index/groups); like JS,
        // they are readable in place and dropped by JSON at data boundaries.
        if (key === "index") return new ComputedValue(objectValue.index);
        if (key === "groups") return new ComputedValue(objectValue.groups);
        // Unknown property on an array reads as `undefined`, matching JS (`[1,2].foo === undefined`),
        // instead of throwing - so defensive access under optional chaining behaves as expected.
        return new ComputedValue(undefined);
      }
      return { target: objectValue, key };
    }

    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    return { target: objectValue as InterpreterObject, key };
  });
}

export function readMember<R>(
  this: MembersHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.map(this.getMemberReference(node), (reference) => {
    if (reference === OptionalShortCircuit) return OptionalShortCircuit;
    if (reference instanceof ComputedValue) return reference.value;
    if (
      reference === undefined ||
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
      return reference.target.storage()[
        reference.key === "-0" ? Number.NaN : Number(reference.key)
      ];
    if (reference.target instanceof SandboxURL)
      return readUrlProperty(reference.target, String(reference.key));
    return reference.target[reference.key];
  });
}

export function writeMember<R>(
  this: MembersHost<R>,
  node: AstNode,
  value: InterpreterValue,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return this.modifyMember(node, () => Effect.succeed({ write: true, next: value, result: value }));
}

export function modifyMember<R>(
  this: MembersHost<R>,
  node: AstNode,
  compute: (
    current: InterpreterValue,
  ) => Effect.Effect<
    { write: boolean; next: InterpreterValue; result: InterpreterValue },
    RuntimeFailure,
    R
  >,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen({ self: this }, function* () {
    const operation = resolveAssignmentReference<R>;
    const reference = yield* operation.call(this, node);
    const { write, next, result } = yield* compute(reference.get());
    if (write) reference.set(next);
    return result;
  });
}

export function resolveAssignmentReference<R>(
  this: MembersHost<R>,
  node: AstNode,
): Effect.Effect<
  { get(): InterpreterValue; set(value: InterpreterValue): InterpreterValue },
  RuntimeFailure,
  R
> {
  return Effect.gen({ self: this }, function* () {
    const reference = yield* this.getMemberReference(node, true);
    if (
      reference === OptionalShortCircuit ||
      reference instanceof ComputedValue ||
      reference === undefined ||
      reference instanceof ToolReference ||
      reference instanceof PromiseMethodReference ||
      reference instanceof IntrinsicReference ||
      reference instanceof GlobalMethodReference
    ) {
      const error =
        reference instanceof ComputedValue ? deferredAccessErrors.get(reference) : undefined;
      return {
        get: () => {
          if (error) throw error;
          return reference instanceof ComputedValue ? reference.value : reference;
        },
        set: () => {
          throw (
            error ??
            new InterpreterRuntimeError("Only data fields may be assigned in CodeMode.", node)
          );
        },
      };
    }
    const key = Array.isArray(reference.target) ? Number(reference.key) : reference.key;
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const get = (): InterpreterValue =>
      reference.target instanceof SandboxBytes
        ? reference.target.storage()[key === "-0" ? Number.NaN : Number(key)]
        : reference.target instanceof SandboxURL
          ? readUrlProperty(reference.target, String(key))
          : Array.isArray(reference.target)
            ? reference.target[Number(key)]
            : reference.target[key];
    return {
      get,
      set: (value: InterpreterValue) => {
        if (
          Array.isArray(reference.target) &&
          (reference.key === "length" ||
            (Predicate.isString(reference.key) && arrayMethods.has(reference.key)))
        )
          throw new InterpreterRuntimeError(
            "Array length and methods cannot be assigned in CodeMode.",
            node,
          );
        this.assignToReference(reference, key, value, node);
        return value;
      },
    };
  });
}

export function rejectCircularInsertion<R>(
  this: MembersHost<R>,
  container: InterpreterObject | InterpreterArray,
  value: InterpreterValue,
  label: string,
  node: AstNode,
  seen = new Set<object>(),
): void {
  if (value === container)
    throw new InterpreterRuntimeError(
      `${label} contains a circular value.`,
      node,
      "InvalidDataValue",
    );
  if (
    value === null ||
    !hasObjectRuntimeType(value) ||
    isRuntimeReference(value) ||
    seen.has(value)
  )
    return;
  seen.add(value);
  const items = Array.isArray(value)
    ? value
    : Reflect.ownKeys(value).map((key) => Object.getOwnPropertyDescriptor(value, key)?.value);
  for (const item of items) this.rejectCircularInsertion(container, item, label, node, seen);
  // Keep visited identities for this reachability walk, including completed branches.
}

export function assignToReference<R>(
  this: MembersHost<R>,
  reference: MemberReference,
  key: GuestPropertyKey,
  next: InterpreterValue,
  node: AstNode,
): void {
  if (reference.target instanceof SandboxBytes) {
    const index = key === "-0" ? Number.NaN : Number(key);
    const number = byteNumber(next);
    if (Number.isInteger(index) && index >= 0 && index < reference.target.length)
      reference.target.storage()[index] = number;
    return;
  }
  if (Array.isArray(reference.target)) {
    const target = reference.target;
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const index = key as number;
    if (!Number.isInteger(index) || index < 0) {
      throw new InterpreterRuntimeError(
        "Array assignment index must be a non-negative integer.",
        node,
        "InvalidDataValue",
      );
    }
    // Confinement: a large sparse index would create an array every later walk pays for.
    assertBoundedCollectionSize(index + 1, "Array assignment", node);
    this.rejectCircularInsertion(target, next, "Array assignment result", node);
    target[index] = next;
    return;
  }
  if (reference.target instanceof SandboxURL) {
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const property = key as string;
    if (!urlWritableProperties.has(property)) {
      throw new InterpreterRuntimeError(`URL.${property} is read-only.`, node).as("TypeError");
    }
    try {
      const incoming = uriArgument(next, `URL.${property} value`);
      // Confinement preflight: URL setters percent-encode, so the worst-case stored
      // length is charged before the native setter materializes it.
      assertBoundedStringLength(uriEncodedLengthUpperBound(incoming), `URL.${property}`, node);
      // Confinement preflight: writing `search` or `href` re-parses the query into the
      // already-materialized searchParams list, so the projected pair count is charged
      // before the native setter runs.
      if (property === "search") assertBoundedQueryPairs(incoming, "URL.search", node);
      else if (property === "href") assertBoundedUrlQueryPairs(incoming, "URL.href", node);
      if (writeUrlProperty(reference.target, property, incoming)) return;
      throw new InterpreterRuntimeError(`URL.${property} is read-only.`, node).as("TypeError");
    } catch (error) {
      if (error instanceof InterpreterRuntimeError || error instanceof ToolRuntimeError)
        throw error;
      throw new InterpreterRuntimeError(`URL.${property} received an invalid value.`, node).as(
        "TypeError",
      );
    }
  }
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  const target = reference.target as InterpreterObject;
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  const objectKey = key;
  if (!Object.hasOwn(target, objectKey))
    assertBoundedCollectionSize(Reflect.ownKeys(target).length + 1, "Object assignment", node);
  this.rejectCircularInsertion(target, next, "Object assignment result", node);
  target[objectKey] = next;
}

export function toPropertyKey<R>(
  this: MembersHost<R>,
  value: InterpreterValue,
  node: AstNode,
): GuestPropertyKey {
  if (Predicate.isSymbol(value)) {
    if (value === GuestIterator) return GuestIterator;
    if (value === GuestAsyncIterator) return GuestAsyncIterator;
  }
  if (Predicate.isString(value) || Predicate.isNumber(value)) {
    return value;
  }

  throw new InterpreterRuntimeError(
    "Property key must be a string, number, or supported iterator symbol.",
    node,
  );
}
