import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { jsonStatics, parseJsonText, stringifyJsonProjection } from "../stdlib/json.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import {
  SandboxBytes,
  SandboxDate,
  SandboxPromise,
  SandboxURL,
  isSandboxValue,
} from "../values.js";
import { MAX_GUEST_COLLECTION_ENTRIES, MAX_GUEST_STRING_LENGTH } from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  isCallableReference as isCallable,
  makeInterpreterObject,
  InterpreterRuntimeError,
} from "./model.js";
import { isDataKeyOf, copyIn } from "../tool-runtime-data.js";

/** JSON callbacks return guest values, not awaited values or boundary copies. */
export const invokeJson = <R>(
  name: string,
  args: InterpreterArray,
  node: AstNode,
  callback: (
    value: InterpreterValue,
    name: string,
    node: AstNode,
  ) => (args: InterpreterArray) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  checkDeadline: () => void,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> =>
  Effect.gen(function* () {
    if (!jsonStatics.has(name))
      throw new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node);
    const fail = (message: string): never => {
      throw new InterpreterRuntimeError(message, node, "InvalidDataValue");
    };
    const check = (depth: number, size = 0): void => {
      checkDeadline();
      if (depth > 32) fail("JSON value exceeds the maximum value depth of 32.");
      if (size > MAX_GUEST_COLLECTION_ENTRIES) fail("JSON collection exceeds the entry limit.");
    };
    const asObject = (value: InterpreterValue): InterpreterObject => {
      if (
        value === null ||
        !hasObjectRuntimeType(value) ||
        (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype)
      )
        fail("JSON value must contain plain objects only.");
      // SAFETY: The closed guest domain and prototype check exclude interpreter wrappers.
      return value as InterpreterObject;
    };
    const keysOf = (value: InterpreterObject): string[] => {
      const keys = Object.keys(value);
      check(0, keys.length);
      for (const key of keys)
        if (!isDataKeyOf(value, key)) fail(`JSON value contains blocked property '${key}'.`);
      return keys;
    };
    if (name === "parse") {
      const text = args[0];
      if (!Predicate.isString(text))
        throw new InterpreterRuntimeError("JSON.parse expects a string.", node);
      if (text.length > MAX_GUEST_STRING_LENGTH) fail("JSON.parse input exceeds the string limit.");
      checkDeadline();
      const parsed = yield* Effect.try({
        try: () => parseJsonText(text),
        catch: (error) =>
          new InterpreterRuntimeError(
            `JSON.parse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            node,
          ).as("SyntaxError"),
      });
      const reviver = args[1];
      if (!isCallable(reviver)) return parsed;
      const apply = callback(reviver, "JSON.parse reviver", node);
      const walk = (
        key: string,
        value: InterpreterValue,
        depth: number,
      ): Effect.Effect<InterpreterValue, RuntimeFailure, R> =>
        Effect.gen(function* () {
          check(depth);
          if (Array.isArray(value)) {
            const length = value.length;
            check(depth, length);
            for (let i = 0; i < length; i++) {
              const result = yield* walk(String(i), value[i], depth + 1);
              if (result === undefined) delete value[i];
              else value[i] = result;
            }
          } else if (
            value !== null &&
            hasObjectRuntimeType(value) &&
            !isSandboxValue(value) &&
            !(value instanceof SandboxPromise) &&
            !isCallable(value)
          ) {
            const object = asObject(value);
            for (const child of keysOf(object)) {
              const result = yield* walk(child, object[child], depth + 1);
              if (result === undefined) delete object[child];
              else object[child] = result;
            }
          }
          return yield* apply([key, value]);
        });
      const result = yield* walk("", parsed, 0);
      // Validate without replacing shallow references or sending promises through copyIn.
      const seen = new Set<object>();
      let entries = 0;
      const validate = (value: InterpreterValue, depth: number): void => {
        check(depth);
        if (++entries > MAX_GUEST_STRING_LENGTH)
          fail("JSON reviver result exceeds the traversal limit.");
        if (isCallable(value) || isSandboxValue(value) || value instanceof SandboxPromise) return;
        if (value === null || !hasObjectRuntimeType(value)) {
          copyIn(value, "JSON reviver result");
          return;
        }
        if (seen.has(value)) fail("JSON reviver result contains a circular value.");
        seen.add(value);
        if (Array.isArray(value)) {
          check(depth, value.length);
          for (const item of value) validate(item, depth + 1);
        } else {
          const object = asObject(value);
          for (const key of keysOf(object)) validate(object[key], depth + 1);
        }
        seen.delete(value);
      };
      validate(result, 0);
      return result;
    }
    const replacer = args[1];
    const apply = isCallable(replacer)
      ? callback(replacer, "JSON.stringify replacer", node)
      : undefined;
    let propertyList: string[] | undefined;
    if (Array.isArray(replacer)) {
      check(0, replacer.length);
      const names = new Set<string>();
      for (const value of replacer) {
        checkDeadline();
        if (!Predicate.isString(value) && !Predicate.isNumber(value)) continue;
        const key = String(value);
        if (key.length > MAX_GUEST_STRING_LENGTH)
          fail("JSON property name exceeds the string limit.");
        names.add(key);
      }
      propertyList = [...names];
    }
    const space = args[2];
    const indent = Predicate.isString(space)
      ? space.slice(0, 10)
      : Predicate.isNumber(space)
        ? " ".repeat(Math.min(10, Math.max(0, Math.trunc(space) || 0)))
        : "";
    let remaining = MAX_GUEST_STRING_LENGTH;
    const spend = (size: number): void => {
      remaining -= size;
      if (remaining < 0)
        fail(
          "JSON.stringify would produce more than the maximum string length. Serialize a smaller value.",
        );
    };
    // Count escaping before native JSON.stringify allocates the output, including lone surrogates.
    const stringSize = (text: string): number => {
      let size = 2;
      for (let i = 0; i < text.length; i++) {
        if (i % 1024 === 0) checkDeadline();
        const c = text.charCodeAt(i);
        if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13)
          size += 2;
        else if (c < 32) size += 6;
        else if (
          c >= 0xd800 &&
          c <= 0xdbff &&
          text.charCodeAt(i + 1) >= 0xdc00 &&
          text.charCodeAt(i + 1) <= 0xdfff
        ) {
          size += 2;
          i++;
        } else if (c >= 0xd800 && c <= 0xdfff) size += 6;
        else size++;
        if (size > MAX_GUEST_STRING_LENGTH) fail("JSON string exceeds the output limit.");
      }
      return size;
    };
    const seen = new Set<object>();
    let visits = 0;
    const chargeVisits = (count: number): void => {
      visits += count;
      if (visits > MAX_GUEST_STRING_LENGTH) fail("JSON.stringify exceeds the traversal limit.");
    };
    const walk = (
      key: string,
      input: InterpreterValue,
      depth: number,
    ): Effect.Effect<InterpreterValue, RuntimeFailure, R> =>
      Effect.gen(function* () {
        check(depth);
        // Omitted properties still cost native property-list lookup work.
        chargeVisits(1);
        let value = input;
        if (value instanceof SandboxDate || value instanceof SandboxURL)
          value = copyIn(value, "JSON.stringify value");
        if (apply) value = yield* apply([key, value]);
        if (value === undefined || Predicate.isSymbol(value) || isCallable(value)) return undefined;
        if (Predicate.isBigInt(value)) return fail("JSON.stringify cannot serialize a BigInt.");
        if (value === null) {
          spend(4);
          return null;
        }
        if (Predicate.isString(value)) {
          spend(stringSize(value));
          return value;
        }
        if (Predicate.isNumber(value)) {
          spend(Number.isFinite(value) ? String(value).length : 4);
          return value;
        }
        if (Predicate.isBoolean(value)) {
          spend(value ? 4 : 5);
          return value;
        }
        const bytes = value instanceof SandboxBytes ? value : undefined;
        // Promises have no enumerable JSON properties. Never inspect or observe their fibers.
        if (value instanceof SandboxPromise || (isSandboxValue(value) && !bytes)) {
          // Native serialization still probes every selected key on this empty projection.
          // Charge that work now; otherwise opaque arrays bypass the traversal bound.
          chargeVisits(propertyList?.length ?? 0);
          spend(2);
          return makeInterpreterObject();
        }
        if (seen.has(value)) fail("JSON.stringify contains a circular value.");
        seen.add(value);
        const array = Array.isArray(value);
        const object = array || bytes ? undefined : asObject(value);
        const keys = object ? keysOf(object) : undefined;
        const selected = array ? undefined : (propertyList ?? keys);
        const length = Array.isArray(value) ? value.length : (selected?.length ?? bytes!.length);
        check(depth, length);
        const outputArray: InterpreterArray = [];
        const outputObject = makeInterpreterObject();
        const output = array ? outputArray : outputObject;
        let count = 0;
        spend(2);
        for (let i = 0; i < length; i++) {
          checkDeadline();
          const child = array || (bytes && !selected) ? String(i) : selected![i]!;
          const original = Array.isArray(value)
            ? value[i]
            : bytes
              ? String(Number(child)) === child
                ? bytes.storage()[Number(child)]
                : undefined
              : Object.hasOwn(object!, child)
                ? object![child]
                : undefined;
          const item = yield* walk(child, original, depth + 1);
          if (item === undefined && !array) continue;
          if (count++) spend(1);
          if (indent) spend(1 + (depth + 1) * indent.length);
          if (!array) spend(stringSize(child) + 1 + (indent ? 1 : 0));
          if (item === undefined) spend(4);
          if (array) outputArray.push(item === undefined ? null : item);
          else outputObject[child] = item;
        }
        if (count && indent) spend(1 + depth * indent.length);
        seen.delete(value);
        return output;
      });
    const projected = yield* walk("", args[0], 0);
    checkDeadline();
    return stringifyJsonProjection(projected, propertyList, indent);
  });
