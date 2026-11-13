import { isCleanupUnconfirmed, isOutcomeUncertain } from "../run/errors.ts";
import type {
  CompactSubagentToolDetails,
  SubagentStartAwaitCardDetails,
} from "./details-schema.ts";
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

export const isUncertainToolFailure = (failure: { readonly code?: string | undefined }): boolean =>
  isOutcomeUncertain(failure) || isCleanupUnconfirmed(failure);

export type ActionFailureDisposition = "unconfirmed" | "failed";

export const actionFailureDisposition = (failure: {
  readonly code?: string | undefined;
}): ActionFailureDisposition => (isUncertainToolFailure(failure) ? "unconfirmed" : "failed");

/** Start failures where no configured route candidate can run at all. */
export const NO_ELIGIBLE_ROUTE_CODES: ReadonlyArray<string> = ["profile_no_eligible_model"];

/** Start failures a route's model or its sign-in caused, which doctor and the profile editor resolve. */
export const MODEL_ROUTE_FAILURE_CODES: ReadonlyArray<string> = [
  ...NO_ELIGIBLE_ROUTE_CODES,
  "model_override_unavailable",
  "pi_model_unknown",
  "pi_model_ambiguous",
  "pi_model_unauthenticated",
  "pi_model_unsupported",
  "pi_effort_unsupported",
  "pi_auth_resolution_failed",
  "pi_auth_unavailable",
];

/** The user's next step for an unavailable route. */
export const ROUTE_RECOVERY =
  "Run /subagents doctor to check sign-in, or /subagents profiles to change the route.";

export const noEligibleRouteRecovery =
  "No configured candidate for this profile can start. Tell the user: /subagents doctor diagnoses models and authentication, and /subagents profiles edits the route. Don't run claude or pi from the shell instead.";

export const unconfirmedActionRecovery =
  "The action may already have taken effect. Do not resend, retry, or launch a replacement while the outcome or cleanup is unconfirmed; inspect the run with agent_read before choosing recovery.";
