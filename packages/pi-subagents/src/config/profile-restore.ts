import type { JsonObject } from "pi-cosmic-core";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { type DeclaredProfileRoute, type ProfileCandidate } from "../profiles/model.ts";
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
  model: value.model,
  effort: value.effort,
  context: value.context,
  writeIntent: value.writeIntent,
  ...(value.openaiFastMode === true && { openaiFastMode: true }),
});

export const routeJson = (route: DeclaredProfileRoute): JsonObject[string] => {
  if (route === "disabled") return route;
  return Arr.isArray<DeclaredProfileRoute>(route)
    ? Arr.map(route, (candidate) => candidateJson(candidate))
    : candidateJson(route);
};

export const isRecord = (value: JsonObject[string] | undefined): value is JsonObject =>
  Predicate.isObject(value);

export const stableJson = (value: JsonObject[string] | undefined): string => {
  if (Arr.isArray(value))
    return `[${Fn.pipe(
      value,
      Arr.map((item) => stableJson(item)),
      Arr.join(","),
    )}]`;
  if (isRecord(value))
    return `{${Fn.pipe(
      Rec.toEntries(value),
      Arr.sortWith(([key]) => key, Order.String),
      Arr.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`),
      Arr.join(","),
    )}}`;
  return JSON.stringify(value);
};
