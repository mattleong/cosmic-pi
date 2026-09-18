import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ResultsContract } from "../results/service.ts";
import { projectResultPage } from "../results/projection.ts";
import { clampModelVisibleText } from "./limits.ts";

export interface ResultReadInput {
  readonly action: "result.read";
  readonly id: string;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly code?: never;
}
export type CodeModeInput =
  | { readonly code: string; readonly intent?: string | undefined; readonly action?: never }
  | ResultReadInput;

export const isExecutionInput = (params: CodeModeInput): boolean =>
  Object.keys(params).every((key) => key === "code" || key === "intent") &&
  Predicate.isString(params.code) &&
  (!("intent" in params) || params.intent === undefined || Predicate.isString(params.intent));

export const readRetainedResult = (
  params: ResultReadInput,
  results: ResultsContract | undefined,
  maxBytes: number,
): Effect.Effect<string> => {
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
    return Effect.succeed(
      clampModelVisibleText(
        "Invalid result.read request. Code is not accepted; offset must be nonnegative and limit 1..30000.",
        maxBytes,
      ),
    );
  }
  return (results?.get(params.id) ?? Effect.succeed(undefined)).pipe(
    Effect.map((artifact) =>
      artifact === undefined
        ? clampModelVisibleText(
            "Retained result unavailable, evicted, or revoked. No execution was run. Do not replay mutations to recover output.",
            maxBytes,
          )
        : projectResultPage(artifact, offset, limit, maxBytes),
    ),
  );
};
