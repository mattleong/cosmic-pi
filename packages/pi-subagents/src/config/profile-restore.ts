import { invokeHostCallback, type JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { MAX_PROFILE_CANDIDATES, type DeclaredProfileRoute } from "../profiles/model.ts";
import { decodeDeclaredProfileCandidate, ownDenseArray } from "./schema.ts";

const MAX_CANDIDATE_KEYS = 8;

const copyCandidate = <CandidateInput>(
  input: CandidateInput,
  omitUndefinedOptionals: boolean,
): JsonObject | undefined => {
  if (!Predicate.isObject(input)) return undefined;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length > MAX_CANDIDATE_KEYS) return undefined;
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
  return copy;
};

const captureCandidates = <DeclarationInput, Candidate>(
  declaration: DeclarationInput,
  candidate: <Input>(input: Input) => Candidate | undefined,
): { readonly single: Candidate } | { readonly list: ReadonlyArray<Candidate> } | undefined =>
  invokeHostCallback(() => {
    if (!Array.isArray(declaration)) {
      const single = candidate(declaration);
      return single && { single };
    }
    const list = ownDenseArray(declaration, MAX_PROFILE_CANDIDATES)?.map(candidate);
    return list && list.length > 0 && list.every(Predicate.isNotUndefined) ? { list } : undefined;
  }, undefined);

export const captureRestoreDeclaration = (
  declaration: JsonObject[string] | undefined,
): { readonly declaration: JsonObject[string] | undefined } | undefined => {
  if (declaration === undefined) return { declaration: undefined };
  if (declaration === "disabled") return { declaration: "disabled" };
  const captured = captureCandidates(declaration, (input) => {
    const copy = copyCandidate(input, false);
    return copy && decodeDeclaredProfileCandidate(copy) ? copy : undefined;
  });
  if (!captured) return undefined;
  return { declaration: "single" in captured ? captured.single : [...captured.list] };
};

export const captureProfilePatchRoute = <ValueInput>(
  declaration: ValueInput,
): { readonly route: DeclaredProfileRoute | undefined } | undefined => {
  if (declaration === undefined) return { route: undefined };
  if (declaration === "disabled") return { route: "disabled" };
  const captured = captureCandidates(declaration, (input) =>
    decodeDeclaredProfileCandidate(copyCandidate(input, true)),
  );
  if (!captured) return undefined;
  return { route: "single" in captured ? captured.single : captured.list };
};

export const isRecord = (value: JsonObject[string] | undefined): value is JsonObject =>
  Predicate.isObject(value);

export const stableJson = <ValueInput>(value: ValueInput): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (Predicate.isObjectOrArray(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
