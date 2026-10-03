import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureCodePreviewPresentationPolicy } from "pi-code-previews";
import { renderSubagentNotification } from "../ui/notification.ts";

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  for (const type of [
    "pi-subagents-completed",
    "pi-subagents-question",
    "pi-subagents-workflow",
    "pi-subagents-proxy-notification",
    "pi-subagents-peer-notice",
  ])
    pi.registerMessageRenderer(type, (message, options, theme) =>
      renderSubagentNotification(
        message,
        options,
        captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact",
        theme,
      ),
    );
}
