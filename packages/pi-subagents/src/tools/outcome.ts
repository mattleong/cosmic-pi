import { isCleanupUnconfirmed, isOutcomeUncertain } from "../run/errors.ts";
import type { SteeringDeliveryState } from "../run/model.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
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

/** A successful observation of a failed worker is not a failed tool operation. */
export const hasSubagentToolFailure = (details: SubagentOutcomeDetails): boolean =>
  details.action === "start"
    ? (details.startFailures?.length ?? 0) > 0
    : "actionFailures" in details && (details.actionFailures?.length ?? 0) > 0;

export const isUncertainToolFailure = (failure: { readonly code?: string | undefined }): boolean =>
  isOutcomeUncertain(failure) || isCleanupUnconfirmed(failure);

/** Delivery evidence is not proof that a model incorporated guidance or permission to retry. */
export const steeringDeliveryEvidence = {
  pending: {
    message: "Guidance delivery is awaiting confirmation",
    detail:
      "Native input may already have been sent; delivery confirmation is pending. Do not resend, retry, or launch a replacement while delivery is unresolved. Inspect status for settlement; activity or a report does not prove guidance was incorporated.",
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
