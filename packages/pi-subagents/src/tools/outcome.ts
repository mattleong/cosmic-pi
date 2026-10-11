import { isCleanupUnconfirmed, isOutcomeUncertain, type SubagentError } from "../run/errors.ts";
import type { SteeringDeliveryState } from "../run/model.ts";
import {
  PENDING_DELIVERY_FAILURE_CODE,
  type CompactSubagentToolDetails,
  type SubagentStartAwaitCardDetails,
} from "./details-schema.ts";
import { decodeCompactToolDetails, decodeStartAwaitCardDetails } from "./details-decode.ts";

export type SubagentOutcomeDetails = SubagentStartAwaitCardDetails | CompactSubagentToolDetails;

export const decodeSubagentOutcomeDetails = <ValueInput>(
  action: string,
  value: ValueInput,
): SubagentOutcomeDetails | undefined => {
  const details = decodeStartAwaitCardDetails(value) ?? decodeCompactToolDetails(value);
  return details?.action === action ? details : undefined;
};

export const hasSubagentToolFailure = (details: SubagentOutcomeDetails): boolean =>
  details.action === "start"
    ? (details.startFailures?.length ?? 0) > 0
    : "actionFailures" in details && (details.actionFailures?.length ?? 0) > 0;

export const hasReturnedFailureEvidence = <ValueInput>(value: ValueInput): boolean => {
  const details = decodeStartAwaitCardDetails(value) ?? decodeCompactToolDetails(value);
  return details !== undefined && hasSubagentToolFailure(details);
};

export const isUncertainToolFailure = (failure: { readonly code?: string | undefined }): boolean =>
  isOutcomeUncertain(failure) || isCleanupUnconfirmed(failure);

export const isPendingDeliveryError = (error: SubagentError): boolean =>
  error._tag === "SubagentProcessError" && actionFailureDisposition("send", error) === "pending";

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

export const marksSubagentToolError = (details: SubagentOutcomeDetails): boolean =>
  details.action === "start"
    ? (details.startFailures?.length ?? 0) > 0
    : "actionFailures" in details &&
      (details.actionFailures ?? []).some(
        (failure) => actionFailureDisposition(details.action, failure) !== "pending",
      );

export const pendingDeliveryEvidence = {
  message: "Guidance is awaiting delivery confirmation",
  detail:
    "Delivery was still being tracked when this call returned; the guidance may already have arrived. Do not resend, retry, interrupt, or replace the worker merely because confirmation is pending. Continue other work or await the worker; stop remains available. Status reports the tracked steeringDelivery state.",
} as const;

export const unconfirmedActionRecovery =
  "The action may already have taken effect. Do not resend, retry, or launch a replacement while the outcome or cleanup is unconfirmed; inspect full subagent_status before choosing recovery.";

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
