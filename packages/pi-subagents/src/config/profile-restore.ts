import { invokeHostCallback, type JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import {
  MAX_PROFILE_CANDIDATES,
  type DeclaredProfileCandidate,
  type DeclaredProfileRoute,
} from "../profiles/model.ts";
import { denseElements, probeFields, probeList, type ProbedFields } from "./probe.ts";
import { decodeDeclaredProfileCandidate } from "./schema.ts";

const MAX_CANDIDATE_KEYS = 8;
const OPTIONAL_CANDIDATE_FIELDS = new Set(["openaiFastMode", "closeOnReport"]);

type CopiedField =
  | { readonly omit: true }
  | { readonly omit: false; readonly key: string; readonly value: string | boolean };

const copyField = (
  key: string,
  field: PropertyDescriptor | undefined,
  omitUndefinedOptionals: boolean,
): CopiedField | undefined => {
  if (!field || !field.enumerable || !("value" in field)) return undefined;
  if (omitUndefinedOptionals && field.value === undefined && OPTIONAL_CANDIDATE_FIELDS.has(key))
    return { omit: true };
  return Predicate.isString(field.value) || Predicate.isBoolean(field.value)
    ? { omit: false, key, value: field.value }
    : undefined;
};

const copyCandidate = (
  record: ProbedFields,
  omitUndefinedOptionals: boolean,
): JsonObject | undefined => {
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)
    return undefined;
  const keys = Reflect.ownKeys(record);
  if (keys.length > MAX_CANDIDATE_KEYS) return undefined;
  const copy: JsonObject = {};
  for (const key of keys) {
    if (!Predicate.isString(key) || key === "__proto__") return undefined;
    const field = copyField(
      key,
      Object.getOwnPropertyDescriptor(record, key),
      omitUndefinedOptionals,
    );
    if (!field) return undefined;
    if (!field.omit) copy[field.key] = field.value;
  }
  return copy;
};

const captureCandidates = <Candidate>(
  declaration: JsonObject[string] | Exclude<DeclaredProfileRoute, "disabled">,
  candidate: (record: ProbedFields) => Candidate | undefined,
): { readonly single: Candidate } | { readonly list: ReadonlyArray<Candidate> } | undefined =>
  invokeHostCallback(() => {
    const declared = probeList(declaration);
    if (!declared) {
      const record = probeFields(declaration);
      const single = record && candidate(record);
      return single && { single };
    }
    const list = denseElements(declared, MAX_PROFILE_CANDIDATES)?.map((element) => {
      const record = probeFields(element);
      return record && candidate(record);
    });
    return list && list.length > 0 && list.every(Predicate.isNotUndefined) ? { list } : undefined;
  }, undefined);

export const captureRestoreDeclaration = (
  declaration: JsonObject[string] | undefined,
): { readonly declaration: JsonObject[string] | undefined } | undefined => {
  if (declaration === undefined) return { declaration: undefined };
  if (declaration === "disabled") return { declaration: "disabled" };
  const captured = captureCandidates(declaration, (record) => {
    const copy = copyCandidate(record, false);
    return copy && decodeDeclaredProfileCandidate(copy) ? copy : undefined;
  });
  if (!captured) return undefined;
  return { declaration: "single" in captured ? captured.single : [...captured.list] };
};

export const captureProfilePatchRoute = (
  declaration: DeclaredProfileRoute | undefined,
): { readonly route: DeclaredProfileRoute | undefined } | undefined => {
  if (declaration === undefined) return { route: undefined };
  if (declaration === "disabled") return { route: "disabled" };
  const captured = captureCandidates(declaration, (record) =>
    decodeDeclaredProfileCandidate(copyCandidate(record, true)),
  );
  if (!captured) return undefined;
  return { route: "single" in captured ? captured.single : captured.list };
};

export const candidateJson = (value: DeclaredProfileCandidate): JsonObject => ({
  host: value.host,
  runtime: value.runtime,
  model: value.model,
  effort: value.effort,
  context: value.context,
  writeIntent: value.writeIntent,
  ...(value.openaiFastMode === true && { openaiFastMode: true }),
  ...(value.closeOnReport !== undefined && { closeOnReport: value.closeOnReport }),
});

export const routeJson = (route: DeclaredProfileRoute): JsonObject[string] => {
  if (route === "disabled") return route;
  return "host" in route
    ? candidateJson(route)
    : route.map((candidate) => candidateJson(candidate));
};

export const isRecord = (value: JsonObject[string] | undefined): value is JsonObject =>
  Predicate.isObject(value);

export const stableJson = (value: JsonObject[string] | undefined): string => {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
