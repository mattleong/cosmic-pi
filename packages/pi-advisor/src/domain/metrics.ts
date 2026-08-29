/** Visible metrics for the current Advisor session. */
export interface AdvisorSessionMetrics {
  readonly cards: number;
  readonly corrections: number;
  readonly cost: number;
  readonly lastAction?:
    | "advice"
    | "discarded"
    | "failure"
    | "guidance"
    | "pass"
    | "perspective"
    | "recovery"
    | "revision"
    | "suppressed";
  readonly latestDurationMs?: number;
  readonly modelResponses: number;
  readonly settledReviews: number;
  readonly totalDurationMs: number;
  readonly totalTokens: number;
}
