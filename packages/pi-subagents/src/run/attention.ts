import type { SubagentRunView } from "./model.ts";

export interface AttentionRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunView["state"];
  readonly question?: { readonly message: string } | undefined;
  readonly writeIntent: SubagentRunView["writeIntent"];
  readonly writeClaims?: ReadonlyArray<string> | undefined;
  readonly writeAudit?: SubagentRunView["writeAudit"] | undefined;
  readonly writeAdmissionPaused?: boolean | undefined;
  readonly writeViolationOffender?: boolean | undefined;
  readonly cleanup?: SubagentRunView["cleanup"] | undefined;
  readonly writerCleanupQuarantined?: boolean | undefined;
  readonly capabilities: SubagentRunView["capabilities"];
}

/** Cleanup is independent of claim containment; both may need attention. */
export const runCleanupAttention = (
  run: Pick<AttentionRun, "cleanup" | "writerCleanupQuarantined">,
): "pending" | "quarantined" | "pool-quarantined" | undefined =>
  run.cleanup?.disposition === "pending" || run.cleanup?.disposition === "quarantined"
    ? run.cleanup.disposition
    : run.writerCleanupQuarantined === true
      ? "pool-quarantined"
      : undefined;

/** Outside-workspace containment of one writer, without a pool-wide admission pause. */
export const isOffenderOnlyContainment = (
  run: Pick<AttentionRun, "writeAdmissionPaused" | "writeViolationOffender">,
): boolean => run.writeViolationOffender === true && run.writeAdmissionPaused !== true;

export type RunAttention =
  | { readonly kind: "containment" }
  | { readonly kind: "admission-paused" }
  | { readonly kind: "paused"; readonly canResume: boolean }
  | { readonly kind: "question"; readonly message: string }
  | { readonly kind: "question-unavailable" };

export const runAttention = (run: AttentionRun): RunAttention | undefined =>
  run.writeViolationOffender === true
    ? { kind: "containment" }
    : run.writeAdmissionPaused === true
      ? { kind: "admission-paused" }
      : run.state === "paused"
        ? { kind: "paused", canResume: run.capabilities.includes("resume") }
        : run.question
          ? { kind: "question", message: run.question.message }
          : run.state === "waiting_for_parent"
            ? { kind: "question-unavailable" }
            : undefined;
