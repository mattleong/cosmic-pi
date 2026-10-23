import { isCleanupUnconfirmed, isOutcomeUncertain } from "../run/errors.ts";
import type { SteeringDeliveryState } from "../run/model.ts";
import type {
  CompactSubagentToolDetails,
  SubagentStartAwaitCardDetails,
} from "./details-schema.ts";
import * as Fn from "effect/Function";
import { decodeOutcomeDetails } from "./details-decode.ts";

type SubagentOutcomeDetails = SubagentStartAwaitCardDetails | CompactSubagentToolDetails;

export const decodeSubagentOutcomeDetails = (
  action: string,
  result: { readonly details?: unknown },
): SubagentOutcomeDetails | undefined => {
  const details = decodeOutcomeDetails(result.details);
  return details?.action === action ? details : undefined;
};

export const hasSubagentToolFailure = (details: SubagentOutcomeDetails): boolean =>
  details.action === "start"
    ? (details.startFailures?.length ?? 0) > 0
    : "actionFailures" in details && (details.actionFailures?.length ?? 0) > 0;

export const hasReturnedFailureEvidence = Fn.flow(
  decodeOutcomeDetails,
  (details) => details !== undefined && hasSubagentToolFailure(details),
);

export const isUncertainToolFailure = (failure: { readonly code?: string | undefined }): boolean =>
  isOutcomeUncertain(failure) || isCleanupUnconfirmed(failure);

export type ActionFailureDisposition = "unconfirmed" | "failed";

export const actionFailureDisposition = (failure: {
  readonly code?: string | undefined;
}): ActionFailureDisposition => (isUncertainToolFailure(failure) ? "unconfirmed" : "failed");

export const countActionFailures = (
  failures: ReadonlyArray<Parameters<typeof actionFailureDisposition>[0]> = [],
) => {
  const counts = { unconfirmed: 0, failed: 0 } satisfies Record<ActionFailureDisposition, number>;
  for (const failure of failures) counts[actionFailureDisposition(failure)] += 1;
  return counts;
};
export type ActionFailureCounts = Readonly<ReturnType<typeof countActionFailures>>;

export const pendingDeliveryEvidence = {
  message: "Guidance is awaiting delivery confirmation",
  detail:
    "Delivery was still being tracked when this call returned; the guidance may already have arrived. Do not resend, retry, interrupt, or replace the worker merely because confirmation is pending. Continue other work or await the worker; stop remains available. agent_read reports the tracked steeringDelivery state.",
} as const;

/** Start failures where no configured route candidate can run at all. */
export const NO_ELIGIBLE_ROUTE_CODES: ReadonlyArray<string> = [
  "profile_no_eligible_model",
  "backend_not_implemented",
];

export const noEligibleRouteRecovery =
  "No configured candidate for this profile can start. Tell the user: /subagents doctor diagnoses runtimes and authentication, and /subagents profiles edits the route. Don't run claude, codex, or pi from the shell instead.";

export const unconfirmedActionRecovery =
  "The action may already have taken effect. Do not resend, retry, or launch a replacement while the outcome or cleanup is unconfirmed; inspect the run with agent_read before choosing recovery.";

export const steeringDeliveryEvidence = {
  pending: {
    message: "Guidance delivery is awaiting confirmation",
    detail:
      "Native input may already have been sent; delivery confirmation is pending. Do not resend, retry, interrupt, or launch a replacement while delivery is unresolved; stop remains available. Inspect status for settlement; activity or a report does not prove guidance was incorporated.",
  },
  confirmed: {
    message: "Native guidance delivery was confirmed",
    detail:
      "Native input acceptance was confirmed. This does not prove the model incorporated the guidance.",
  },
  "not-sent": {
    message: "Guidance was not sent",
    detail:
      "Native input was confirmed not sent. Inspect the original action failure and current status before choosing recovery.",
  },
  "report-unconfirmed": {
    message: "A report arrived before guidance delivery was confirmed",
    detail:
      "Assignment completion is confirmed by an accepted report, but native guidance delivery and model incorporation are unconfirmed. Inspect the report against the guidance; do not blindly resend. Normal run and cleanup rules still apply.",
  },
  unresolved: {
    message: "Guidance delivery remains unresolved",
    detail:
      "Delivery tracking ended without native confirmation; input may already have arrived. Do not resend, retry, or launch a replacement automatically. Inspect full status and reconcile the report and guidance manually.",
  },
} satisfies Record<SteeringDeliveryState, { readonly message: string; readonly detail: string }>;
