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
export type ResultCapture =
  | { readonly status: "captured"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: "capture-limit" | "runtime-unavailable" };
export interface ResultPageRecovery {
  readonly action: "result.read";
  readonly id: string;
  readonly offset: number;
}
export interface ResultPage<ReceiptEvidence = never> {
  readonly id: string;
  readonly outcome: ExecutionOutcome;
  readonly kind: "output" | "failure-receipt";
  readonly offset: number;
  readonly next: number | null;
  readonly total: number;
  readonly text: string;
  readonly recovery?: ResultPageRecovery;
  readonly receipts?: ReceiptEvidence;
}
