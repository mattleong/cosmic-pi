/** Member writes: assignment, compound updates, deletion, and the circular-insertion guard. */
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { byteNumber } from "../stdlib/bytes.js";
import { uriArgument, urlWritableProperties, writeUrlProperty } from "../stdlib/url.js";
import { SandboxBytes, SandboxRegExp, SandboxURL } from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedQueryPairs,
  assertBoundedStringLength,
  assertBoundedUrlQueryPairs,
  uriEncodedLengthUpperBound,
} from "./confinement.js";
import {
  type AstNode,
  type GuestPropertyKey,
  ComputedValue,
  getNode,
  GlobalMethodReference,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  IntrinsicReference,
  type MemberReference,
  OptionalShortCircuit,
  PromiseMethodReference,
  ToolReference,
} from "./model.js";
import { coerceToNumber } from "./conversions.js";
import { type Activation } from "./activation.js";
import { isRuntimeReference } from "./references.js";
import { ToolRuntimeError } from "../tool-runtime-error.js";
import { arrayMethods } from "./array-methods.js";
import { deferredAccessErrors, getMemberReference, readReference } from "./members.js";

export function deleteMember<R>(
  act: Activation<R>,
  argument: AstNode,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const target = argument.type === "ChainExpression" ? getNode(argument, "expression") : argument;
  if (target.type !== "MemberExpression")
    throw new InterpreterRuntimeError("Only object properties can be deleted.", node).as(
      "SyntaxError",
    );
  return Effect.map(getMemberReference(act, target), (reference) => {
    if (reference === OptionalShortCircuit) return true;
    if (reference instanceof ComputedValue) return true;
    if (
      reference === undefined ||
      reference instanceof ToolReference ||
      reference instanceof PromiseMethodReference ||
      reference instanceof IntrinsicReference ||
      reference instanceof GlobalMethodReference ||
      reference.target instanceof SandboxBytes ||
      reference.target instanceof SandboxURL ||
      reference.target instanceof SandboxRegExp
    )
      throw new InterpreterRuntimeError("Only data fields can be deleted in CodeMode.", node).as(
        "TypeError",
      );
    if (Array.isArray(reference.target)) {
      if (reference.key === "length")
        throw new InterpreterRuntimeError("Cannot delete an array's length.", node).as("TypeError");
      return delete reference.target[Number(reference.key)];
    }
    return delete reference.target[reference.key];
  });
}

export function modifyMember<R>(
  act: Activation<R>,
  node: AstNode,
  compute: (
    current: InterpreterValue,
  ) => Effect.Effect<
    { write: boolean; next: InterpreterValue; result: InterpreterValue },
    RuntimeFailure,
    R
  >,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const reference = yield* resolveAssignmentReference(act, node);
    const { write, next, result } = yield* compute(reference.get());
    if (write) reference.set(next);
    return result;
  });
}

export function resolveAssignmentReference<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<
  { get(): InterpreterValue; set(value: InterpreterValue): InterpreterValue },
  RuntimeFailure,
  R
> {
  return Effect.gen(function* () {
    const reference = yield* getMemberReference(act, node, true);
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
    const get = (): InterpreterValue => readReference(reference);
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
        assignToReference(reference, key, value, node);
        return value;
      },
    };
  });
}

export function rejectCircularInsertion(
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
  for (const item of items) rejectCircularInsertion(container, item, label, node, seen);
  // Keep visited identities for this reachability walk, including completed branches.
}

export function assignToReference(
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
    rejectCircularInsertion(target, next, "Array assignment result", node);
    target[index] = next;
    return;
  }
  if (reference.target instanceof SandboxRegExp) {
    reference.target.regex.lastIndex = coerceToNumber(next);
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
  rejectCircularInsertion(target, next, "Object assignment result", node);
  target[objectKey] = next;
}
