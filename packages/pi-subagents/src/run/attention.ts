import type { SubagentRunView } from "./model.ts";

export interface AttentionRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunView["state"];
  readonly question?: { readonly message: string } | undefined;
  readonly writeIntent: SubagentRunView["writeIntent"];
  readonly cleanup?: SubagentRunView["cleanup"] | undefined;
  readonly writerCleanupQuarantined?: boolean | undefined;
}

/**
 * Cleanup is independent of the run state; both may need attention. Pending cleanup settles on
 * its own, so only quarantine needs the parent.
 */
export const runCleanupAttention = (
  run: Pick<AttentionRun, "cleanup" | "writerCleanupQuarantined">,
): "quarantined" | "pool-quarantined" | undefined =>
  run.cleanup?.disposition === "quarantined"
    ? "quarantined"
    : run.writerCleanupQuarantined === true
      ? "pool-quarantined"
      : undefined;

type RunAttention =
  | { readonly kind: "paused" }
  | { readonly kind: "question"; readonly message: string }
  | { readonly kind: "question-unavailable" };

export const runAttention = (run: AttentionRun): RunAttention | undefined =>
  run.state === "paused"
    ? { kind: "paused" }
    : run.question
      ? { kind: "question", message: run.question.message }
      : run.state === "waiting_for_parent"
        ? { kind: "question-unavailable" }
        : undefined;
