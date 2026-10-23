import * as Arr from "effect/Array";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { captureCodePreviewPresentationPolicy } from "pi-code-previews";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { AGENT_MESSAGE_TYPE } from "../boundary/host-agent-messages.ts";
import { STOPPED_RUNS_MESSAGE_TYPE } from "../boundary/host-stopped-runs.ts";
import { renderAgentMessage } from "../ui/agent-message.ts";
import { renderSubagentNotification } from "../ui/notification.ts";
import type { WorkspaceSwept } from "../workspace/model.ts";

export const renderSubagentMessage: MessageRenderer = (message, options, theme) =>
  renderSubagentNotification(
    message,
    options,
    captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact",
    theme,
  );

export const renderAgentMessageEntry: MessageRenderer = (message, options, theme) =>
  renderAgentMessage(
    message,
    options,
    captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact",
    theme,
  );

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(AGENT_MESSAGE_TYPE, renderAgentMessageEntry);
  for (const type of [
    "pi-subagents-completed",
    "pi-subagents-question",
    "pi-subagents-proxy-notification",
    "pi-subagents-peer-notice",
    STOPPED_RUNS_MESSAGE_TYPE,
  ])
    pi.registerMessageRenderer(type, renderSubagentMessage);
}

const MAX_LISTED_SWEPT = 10;

/** The user-only notice naming the orphaned workspaces the startup sweep discarded. */
export function orphanSweepNotice(swept: ReadonlyArray<WorkspaceSwept>): string {
  const listed = Arr.map(
    swept.slice(0, MAX_LISTED_SWEPT),
    (entry) =>
      `- ${entry.workspaceId} (${countLabel(entry.changedPathCount, "changed file")}): ${sanitizeTerminalLine(entry.patchPath)}`,
  );
  return Arr.join(
    [
      `Discarded ${countLabel(swept.length, "orphaned subagent workspace")} unchanged for 30 days. Each patch is kept for 7 days; apply one with git apply in its checkout.`,
      ...listed,
      ...(swept.length > MAX_LISTED_SWEPT ? [`- and ${swept.length - MAX_LISTED_SWEPT} more`] : []),
    ],
    "\n",
  );
}
