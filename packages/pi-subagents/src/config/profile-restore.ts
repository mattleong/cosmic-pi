import { hasObjectRuntimeType, type JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { MAX_PROFILE_CANDIDATES } from "../profiles/model.ts";
import { decodeProfileCandidate } from "./schema.ts";

/** Validate without normalizing: omission, explicit false, and route array shape are data. */
export function captureRestoreDeclaration(
  declaration: JsonObject[string] | undefined,
  sourceVersion: number,
): { readonly declaration: JsonObject[string] | undefined } | undefined {
  if (sourceVersion !== 4 && sourceVersion !== 5 && sourceVersion !== 6) return undefined;
  if (declaration === undefined || declaration === "disabled") return { declaration };
  try {
    const candidate = (input: JsonObject[string]): JsonObject | undefined => {
      if (!hasObjectRuntimeType(input) || input === null || Array.isArray(input)) return undefined;
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      )
        return undefined;
      const keys = Reflect.ownKeys(input);
      if (keys.length > 8) return undefined;
      const copy: JsonObject = {};
      for (const key of keys) {
        if (!Predicate.isString(key) || key === "__proto__") return undefined;
        const field = Object.getOwnPropertyDescriptor(input, key);
        if (!field || !field.enumerable || !("value" in field)) return undefined;
        const value: unknown = field.value;
        if (!Predicate.isString(value) && !Predicate.isBoolean(value)) return undefined;
        copy[key] = value;
      }
      return decodeProfileCandidate(copy, sourceVersion) ? copy : undefined;
    };
    if (!Array.isArray(declaration)) {
      const copy = candidate(declaration);
      return copy ? { declaration: copy } : undefined;
    }
    if (Object.getPrototypeOf(declaration) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(declaration, "length")?.value;
    if (
      !Predicate.isNumber(length) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_PROFILE_CANDIDATES
    )
      return undefined;
    if (Reflect.ownKeys(declaration).length !== length + 1) return undefined;
    const copy: JsonObject[] = [];
    for (let index = 0; index < length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(declaration, String(index));
      if (!field || !("value" in field)) return undefined;
      const item = candidate(field.value);
      if (!item) return undefined;
      copy.push(item);
    }
    return { declaration: copy };
  } catch {
    return undefined;
  }
}
