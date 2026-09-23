import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ResultsContract } from "../results/service.ts";
import { projectResultPage } from "../results/projection.ts";
import { resultReadFailure, type ResultReadProjection } from "../results/read-presentation.ts";

export interface ResultReadInput {
  readonly action: "result.read";
  readonly id: string;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly code?: never;
  readonly intent?: never;
}

export interface CodeModeStatusInput {
  readonly action: "status";
  readonly code?: never;
  readonly intent?: never;
  readonly id?: never;
  readonly offset?: never;
  readonly limit?: never;
}

export type CodeModeInput =
  | { readonly code: string; readonly intent?: string | undefined; readonly action?: never }
  | ResultReadInput
  | CodeModeStatusInput;

export const isExecutionInput = (params: CodeModeInput): boolean =>
  Object.keys(params).every((key) => key === "code" || key === "intent") &&
  Predicate.isString(params.code) &&
  (!("intent" in params) || params.intent === undefined || Predicate.isString(params.intent));

export const isStatusInput = (params: CodeModeInput): params is CodeModeStatusInput =>
  params.action === "status" && Object.keys(params).every((key) => key === "action");

export const readRetainedResult = (
  params: ResultReadInput,
  results: ResultsContract | undefined,
  maxBytes: number,
): Effect.Effect<ResultReadProjection> => {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 30_000;
  if (
    Object.keys(params).some((key) => !["action", "id", "offset", "limit"].includes(key)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 30_000 ||
    !Predicate.isString(params.id) ||
    params.id.length < 1 ||
    params.id.length > 128
  ) {
    return Effect.succeed(resultReadFailure("invalid-input", maxBytes));
  }
  return (results?.get(params.id) ?? Effect.void).pipe(
    Effect.map((artifact) =>
      artifact === undefined
        ? resultReadFailure("unavailable", maxBytes)
        : projectResultPage(artifact, offset, limit, maxBytes),
    ),
  );
};
