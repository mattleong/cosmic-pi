import type { AdvisorCheckpoint, AdvisorCheckpointRequest } from "../../src/runtime/runtime.ts";

/** A completed final assistant turn event. */
export function finalTurn(text = "candidate") {
  return {
    type: "turn_end",
    turnIndex: 1,
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    toolResults: [],
  };
}

/**
 * A correlated pass checkpoint. Call sites keep their exact asserted
 * stateSummary/summary values via explicit options; the `suggestions` key is
 * present only when a call site provides one.
 */
export function passCheckpoint(
  request: AdvisorCheckpointRequest,
  options: {
    stateSummary?: string;
    summary?: string;
    suggestions?: AdvisorCheckpoint["suggestions"];
  } = {},
): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: options.stateSummary ?? "compact",
    verdict: "pass",
    summary: options.summary ?? "No issue.",
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
    findings: [],
  };
}
