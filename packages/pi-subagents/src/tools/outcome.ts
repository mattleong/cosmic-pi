import { isCleanupUnconfirmed, isOutcomeUncertain, type SubagentError } from "../run/errors.ts";
import type { SteeringDeliveryState } from "../run/model.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  PENDING_DELIVERY_FAILURE_CODE,
  type CompactSubagentToolDetails,
  type SubagentStartAwaitCardDetails,
} from "./details-schema.ts";

export type SubagentOutcomeDetails = SubagentStartAwaitCardDetails | CompactSubagentToolDetails;

/** Match the owned action, never raw text or the state of an observed worker. */
export const decodeSubagentOutcomeDetails = <ValueInput>(
  action: string,
  value: ValueInput,
): SubagentOutcomeDetails | undefined => {
  const details = decodeStartAwaitCardDetails(value) ?? decodeCompactToolDetails(value);
  return details?.action === action ? details : undefined;
};

/**
 * Any returned target-operation failure evidence, including pending delivery. Summaries and
 * expansion use this; receipt policy uses `marksSubagentToolError`. A successful observation of
 * a failed worker is not a failed tool operation.
 */
export const hasSubagentToolFailure = (details: SubagentOutcomeDetails): boolean =>
  details.action === "start"
    ? (details.startFailures?.length ?? 0) > 0
    : "actionFailures" in details && (details.actionFailures?.length ?? 0) > 0;

/** Unknown-input form for renderers that must keep returned failure evidence visible. */
export const hasReturnedFailureEvidence = <ValueInput>(value: ValueInput): boolean => {
  const details = decodeStartAwaitCardDetails(value) ?? decodeCompactToolDetails(value);
  return details !== undefined && hasSubagentToolFailure(details);
};

export const isUncertainToolFailure = (failure: { readonly code?: string | undefined }): boolean =>
  isOutcomeUncertain(failure) || isCleanupUnconfirmed(failure);

/** Only the backend's explicit typed flag on its exact steering code reports pending delivery. */
export const isPendingDeliveryError = (error: SubagentError): boolean =>
  error._tag === "SubagentProcessError" &&
  error.pendingDelivery === true &&
  error.code === PENDING_DELIVERY_FAILURE_CODE;

/**
 * `pending`: typed guidance delivery is still tracked by the backend (not a tool error).
 * `unconfirmed`: outcome or cleanup is uncertain by code (error; never resend or retry).
 * `failed`: a definite failure. Historical or unflagged uncertain codes stay `unconfirmed`, and
 * a flag on any other action or code keeps its code-based classification.
 */
export type ActionFailureDisposition = "pending" | "unconfirmed" | "failed";

export const actionFailureDisposition = (
  action: string,
  failure: { readonly code?: string | undefined; readonly pendingDelivery?: boolean | undefined },
): ActionFailureDisposition =>
  action === "send" &&
  failure.pendingDelivery === true &&
  failure.code === PENDING_DELIVERY_FAILURE_CODE
    ? "pending"
    : isUncertainToolFailure(failure)
      ? "unconfirmed"
      : "failed";

export const countActionFailures = (
  action: string,
  failures: ReadonlyArray<Parameters<typeof actionFailureDisposition>[1]> = [],
) => {
  const counts = { pending: 0, unconfirmed: 0, failed: 0 } satisfies Record<
    ActionFailureDisposition,
    number
  >;
  for (const failure of failures) counts[actionFailureDisposition(action, failure)] += 1;
  return counts;
};
export type ActionFailureCounts = Readonly<ReturnType<typeof countActionFailures>>;

/** Receipt policy: pending-only, and pending plus confirmed, results are not Pi tool errors. */
export const marksSubagentToolError = (details: SubagentOutcomeDetails): boolean =>
  details.action === "start"
    ? (details.startFailures?.length ?? 0) > 0
    : "actionFailures" in details &&
      (details.actionFailures ?? []).some(
        (failure) => actionFailureDisposition(details.action, failure) !== "pending",
      );

/** Typed pending send evidence: neither delivered nor failed, and never a reason to resend. */
export const pendingDeliveryEvidence = {
  message: "Guidance is awaiting delivery confirmation",
  detail:
    "Delivery was still being tracked when this call returned; the guidance may already have arrived. Do not resend, retry, interrupt, or replace the worker merely because confirmation is pending. Continue other work or await the worker; stop remains available. Status reports the tracked steeringDelivery state.",
} as const;

export const unconfirmedActionRecovery =
  "The action may already have taken effect. Do not resend, retry, or launch a replacement while the outcome or cleanup is unconfirmed; inspect full subagent_status before choosing recovery.";

/** Delivery evidence is not proof that a model incorporated guidance or permission to retry. */
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
