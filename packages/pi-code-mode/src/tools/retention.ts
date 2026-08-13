import type { CodeModeToolDetails } from "./format.ts";

/** Bounded one-shot handoff for details Pi otherwise drops when tool execution throws. */
export interface FailureDetailsRetention {
  readonly retain: (toolCallId: string, details: CodeModeToolDetails) => void;
  readonly consume: (toolCallId: string) => CodeModeToolDetails | undefined;
}

export const copyCodeModeToolDetails = (details: CodeModeToolDetails): CodeModeToolDetails => ({
  ...details,
  toolCalls: details.toolCalls.map((call) => ({ ...call })),
  ...(details.counts === undefined ? {} : { counts: { ...details.counts } }),
});

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
  return {
    retain: (toolCallId, details) => {
      retained.delete(toolCallId);
      retained.set(toolCallId, copyCodeModeToolDetails(details));
      while (retained.size > capacity) {
        const oldest = retained.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        retained.delete(oldest);
      }
    },
    consume: (toolCallId) => {
      const details = retained.get(toolCallId);
      retained.delete(toolCallId);
      return details === undefined ? undefined : copyCodeModeToolDetails(details);
    },
  };
};
