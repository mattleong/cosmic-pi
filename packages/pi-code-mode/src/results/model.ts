import type * as Effect from "effect/Effect";

/** Private, session-only output artifacts. No guest values or dispatch authority are retained. */
export const RESULT_MAX_BYTES = 8 * 1024 * 1024;
export const RESULT_SESSION_BYTES = 64 * 1024 * 1024;
export const RESULT_MAX_ENTRIES = 32;
export const RESULT_MAX_VISITS = 100_000;

export type ExecutionOutcome = "succeeded" | "failed" | "cancelled";
export interface ResultArtifact {
  readonly id: string;
  readonly text: string;
  readonly outcome: ExecutionOutcome;
  readonly kind: "output" | "failure-receipt";
  readonly cost: number;
}
/**
 * A validated artifact that is not yet stored, charged, identified or readable. `commit` is one
 * total, synchronous, requirement-free Ref transition, so the host continuation that makes the
 * final cancellation check can publish without an await. It yields the new ID, or `undefined`
 * once used or after the store closes. Dropping an uncommitted artifact needs no cleanup.
 */
export interface PreparedResult {
  readonly commit: Effect.Effect<string | undefined>;
}
export type ResultCapture =
  | { readonly status: "captured"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: "capture-limit" | "runtime-unavailable" };
