import type { CodeModeToolDetails } from "./format.ts";

/** Bounded one-shot handoff for details Pi otherwise drops when tool execution throws. */
export interface FailureDetailsRetention {
  readonly retain: (toolCallId: string, details: CodeModeToolDetails) => void;
  readonly consume: (toolCallId: string) => CodeModeToolDetails | undefined;
}

export const applyRetainedCodeModeFailureDetails = (
  retention: FailureDetailsRetention,
  event: { readonly toolName: string; readonly toolCallId: string; readonly isError: boolean },
): { readonly details: CodeModeToolDetails } | undefined => {
  if (event.toolName !== "code_mode" || event.isError !== true) return undefined;
  const details = retention.consume(event.toolCallId);
  return details === undefined ? undefined : { details };
};

export const makeFailureDetailsRetention = (capacity = 16): FailureDetailsRetention => {
  const retained = new Map<string, CodeModeToolDetails>();
  const copy = (details: CodeModeToolDetails): CodeModeToolDetails => {
    const copied = { ...details, toolCalls: details.toolCalls.map((row) => ({ ...row })) };
    if (copied.counts !== undefined) copied.counts = { ...copied.counts };
    return copied;
  };
  return {
    retain: (toolCallId, details) => {
      retained.delete(toolCallId);
      retained.set(toolCallId, copy(details));
      while (retained.size > capacity) {
        // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
        const oldest = retained.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        retained.delete(oldest);
      }
    },
    consume: (toolCallId) => {
      const details = retained.get(toolCallId);
      retained.delete(toolCallId);
      return details === undefined ? undefined : copy(details);
    },
  };
};
