import { AdvisorRuntimeResetRequiredError } from "../runtime/runtime.ts";

/**
 * Third-party/runtime compatibility classifier. Message inspection is confined to this adapter;
 * application queue control flow branches only on its finite result.
 */
export const classifyAdvisorRuntimeFailure = (error: unknown): "reset-required" | "other" => {
  if (
    error instanceof AdvisorRuntimeResetRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ResetRequired")
  )
    return "reset-required";
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return /(?:context|overflow|too large|maximum response size|malformed checkpoint|compaction)/.test(
    message,
  )
    ? "reset-required"
    : "other";
};
