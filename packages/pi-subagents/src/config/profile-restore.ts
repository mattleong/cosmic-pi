import { invokeHostCallback, type JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { MAX_PROFILE_CANDIDATES } from "../profiles/model.ts";
import {
  decodeProfileCandidate,
  isSupportedConfigVersion,
  ownDenseArray,
  SUBAGENT_CONFIG_VERSION,
} from "./schema.ts";

function captureDeclaration<ValueInput>(
  declaration: ValueInput,
  sourceVersion: number,
  omitUndefinedOptionals: boolean,
): { readonly declaration: JsonObject[string] | undefined } | undefined {
  if (!isSupportedConfigVersion(sourceVersion)) return undefined;
  if (declaration === undefined) return { declaration: undefined };
  if (declaration === "disabled") return { declaration: "disabled" };
  const candidate = <CandidateInput>(input: CandidateInput): JsonObject | undefined => {
    if (!Predicate.isObject(input)) return undefined;
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.length > 8) return undefined;
    const copy: JsonObject = {};
    for (const key of keys) {
      if (!Predicate.isString(key) || key === "__proto__") return undefined;
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !field.enumerable || !("value" in field)) return undefined;
      const value: unknown = field.value;
      if (
        omitUndefinedOptionals &&
        value === undefined &&
        (key === "openaiFastMode" || key === "closeOnReport")
      )
        continue;
      if (!Predicate.isString(value) && !Predicate.isBoolean(value)) return undefined;
      copy[key] = value;
    }
    return decodeProfileCandidate(copy, sourceVersion) ? copy : undefined;
  };
  return invokeHostCallback(() => {
    if (!Array.isArray(declaration)) {
      const copy = candidate(declaration);
      return copy && { declaration: copy };
    }
    const copies = ownDenseArray(declaration, MAX_PROFILE_CANDIDATES)?.map(candidate);
    return copies && copies.length > 0 && copies.every(Predicate.isNotUndefined)
      ? { declaration: copies }
      : undefined;
  }, undefined);
}

/** Validate without normalizing: omission, explicit false, and route array shape are data. */
export const captureRestoreDeclaration = (
  declaration: JsonObject[string] | undefined,
  sourceVersion: number,
): { readonly declaration: JsonObject[string] | undefined } | undefined =>
  captureDeclaration(declaration, sourceVersion, false);

/** Typed patches permit undefined optional fields, which persistence omits. */
export const captureProfilePatchDeclaration = <ValueInput>(
  declaration: ValueInput,
): { readonly declaration: JsonObject[string] | undefined } | undefined =>
  captureDeclaration(declaration, SUBAGENT_CONFIG_VERSION, true);

export const isRecord = (value: JsonObject[string] | undefined): value is JsonObject =>
  Predicate.isObject(value);

/** Sorted-key JSON so equal documents compare equal regardless of key order. */
export const stableJson = <ValueInput>(value: ValueInput): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (Predicate.isObjectOrArray(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const legacyCandidateJson = ({ fastMode, ...candidate }: JsonObject): JsonObject => ({
  ...candidate,
  ...(fastMode === true && { openaiFastMode: true }),
});

export const migrateLegacyRouteJson = (value: JsonObject[string]): JsonObject[string] => {
  if (value === "disabled") return value;
  if (Array.isArray(value))
    return value.map((candidate) =>
      isRecord(candidate) ? legacyCandidateJson(candidate) : candidate,
    );
  return isRecord(value) ? legacyCandidateJson(value) : value;
};
