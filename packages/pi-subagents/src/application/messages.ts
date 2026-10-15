import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { captureCodePreviewPresentationPolicy } from "pi-code-previews";
import { STOPPED_RUNS_MESSAGE_TYPE } from "../boundary/host-stopped-runs.ts";
import { renderSubagentNotification } from "../ui/notification.ts";

export const renderSubagentMessage: MessageRenderer = (message, options, theme) =>
  renderSubagentNotification(
    message,
    options,
    captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact",
    theme,
  );

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  for (const type of [
    "pi-subagents-completed",
    "pi-subagents-question",
    "pi-subagents-proxy-notification",
    "pi-subagents-peer-notice",
    STOPPED_RUNS_MESSAGE_TYPE,
  ])
    pi.registerMessageRenderer(type, renderSubagentMessage);
}
