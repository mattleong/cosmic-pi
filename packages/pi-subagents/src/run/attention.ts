/**
 * What a run needs from its parent before it can continue. One precedence feeds every view:
 * the agent's recovery steps, compact issue lines, the preview renderer, and workflow status.
 */
import type { SubagentRunView } from "./model.ts";

/** The fields attention depends on, shared by run views and projected cards. */
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
  readonly capabilities: SubagentRunView["capabilities"];
}

export type RunAttention =
  /** The run wrote outside its claims and is being contained. */
  | { readonly kind: "containment" }
  /** Writer admission is paused for this peer while another run is contained. */
  | { readonly kind: "admission-paused" }
  | { readonly kind: "paused"; readonly canResume: boolean }
  | { readonly kind: "question"; readonly message: string }
  /** Waiting for the parent, but no question is projected. */
  | { readonly kind: "question-unavailable" };

/** The one attention state a run is in, by precedence, or undefined when it needs nothing. */
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
