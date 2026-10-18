import type { JsonObject } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import {
  isDeclaredCandidateList,
  type DeclaredProfileRoute,
  type ProfileCandidate,
} from "../profiles/model.ts";
import { decodeDeclaredProfileRoute } from "./schema.ts";

/** Undo writes the opening declaration back exactly, including its key order. */
export const captureRestoreDeclaration = (
  declaration: JsonObject[string] | undefined,
): { readonly declaration: JsonObject[string] | undefined } | undefined => {
  if (declaration === undefined) return { declaration: undefined };
  return decodeDeclaredProfileRoute(declaration)
    ? { declaration: structuredClone(declaration) }
    : undefined;
};

export const captureProfilePatchRoute = (
  declaration: DeclaredProfileRoute | undefined,
): { readonly route: DeclaredProfileRoute | undefined } | undefined => {
  if (declaration === undefined) return { route: undefined };
  const route = decodeDeclaredProfileRoute(declaration);
  return route && { route };
};

export const candidateJson = (value: ProfileCandidate): JsonObject => ({
  runtime: value.runtime,
  model: value.model,
  effort: value.effort,
  context: value.context,
  writeIntent: value.writeIntent,
  ...(value.openaiFastMode === true && { openaiFastMode: true }),
});

export const routeJson = (route: DeclaredProfileRoute): JsonObject[string] => {
  if (route === "disabled") return route;
  return isDeclaredCandidateList(route)
    ? route.map((candidate) => candidateJson(candidate))
    : candidateJson(route);
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
