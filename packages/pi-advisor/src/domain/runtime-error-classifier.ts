import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { AdvisorModelError, type AdvisorModelErrorKind } from "../runtime/client.ts";
import { AdvisorRuntimeResetRequiredError } from "../runtime/runtime.ts";

const MODEL_ERROR_KIND_CLASSIFICATION = {
  authentication: "authentication",
  configuration: "model",
  timeout: "timeout",
  unavailable: "model",
  aborted: "cancelled",
  "response-format": "response-format",
  unknown: "provider",
} satisfies Record<AdvisorModelErrorKind, string>;

export function classifyFailure<ErrorInput>(error: ErrorInput): string {
  if (error instanceof AdvisorModelError && error.kind)
    return MODEL_ERROR_KIND_CLASSIFICATION[error.kind];
  // Message heuristics remain only as a fallback for errors produced outside this extension.
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("auth") || message.includes("credential") || message.includes("api key")) {
    return "authentication";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("unavailable") || message.includes("not configured")) return "model";
  if (message.includes("abort")) return "cancelled";
  return "provider";
}

/**
 * Third-party/runtime compatibility classifier. Message inspection is confined to this adapter;
 * application queue control flow branches only on its finite result.
 */
export const classifyAdvisorRuntimeFailure = <ErrorInput>(
  error: ErrorInput,
): "reset-required" | "other" => {
  if (
    error instanceof AdvisorRuntimeResetRequiredError ||
    (hasObjectRuntimeType(error) &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ResetRequired")
  )
    return "reset-required";
  if (error instanceof AdvisorModelError) return "other";
  const message =
    hasObjectRuntimeType(error) &&
    error !== null &&
    "message" in error &&
    Predicate.isString(error.message)
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return /(?:context|overflow|too large|maximum response size|malformed checkpoint|compaction)/.test(
    message,
  )
    ? "reset-required"
    : "other";
};
