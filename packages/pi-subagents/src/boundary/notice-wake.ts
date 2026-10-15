import type { BoundaryContextPreview } from "@earendil-works/pi-coding-agent";

type ContextMessage = BoundaryContextPreview["contextMessages"][number];

const isNoticeOf =
  (customTypes: ReadonlySet<string>) =>
  (message: ContextMessage): boolean =>
    message.role === "custom" && customTypes.has(message.customType);

/**
 * Whether a notice of one of `customTypes` arrived after the model's latest reply: either in the
 * context after the last assistant message, or held by Pi to be appended at this boundary. Such a
 * notice was appended without starting a turn, so the settling run has to continue for the model to
 * see it.
 */
export const hasUnansweredNotice = (
  context: BoundaryContextPreview,
  customTypes: ReadonlySet<string>,
): boolean => {
  const isNotice = isNoticeOf(customTypes);
  if (context.pendingMessages.some(isNotice)) return true;
  const messages = context.contextMessages;
  const lastReply = messages.findLastIndex((message) => message.role === "assistant");
  return messages.slice(lastReply + 1).some(isNotice);
};
