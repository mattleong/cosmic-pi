import { hasObjectRuntimeType, isStringValue } from "pi-cosmic-core";
import { AdvisorRuntimeResetRequiredError } from "../runtime/runtime.ts";

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
  const message =
    hasObjectRuntimeType(error) &&
    error !== null &&
    "message" in error &&
    isStringValue(error.message)
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return /(?:context|overflow|too large|maximum response size|malformed checkpoint|compaction)/.test(
    message,
  )
    ? "reset-required"
    : "other";
};
