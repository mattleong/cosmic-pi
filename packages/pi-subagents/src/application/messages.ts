import * as Arr from "effect/Array";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { withCodePreviewMessageShell } from "pi-code-previews";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core/display";
import {
  originFromDetails,
  registerMessageOrigins,
  type MessageOrigin,
} from "pi-cosmic-core/host-message-origin";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { AGENT_MESSAGE_TYPE } from "../boundary/host-agent-messages.ts";
import {
  FINAL_REPORT_REMINDER_MESSAGE_TYPE,
  PEER_NOTICE_MESSAGE_TYPE,
  PROXY_NOTIFICATION_MESSAGE_TYPE,
} from "../boundary/host-child-settle.ts";
import { COMPLETION_MESSAGE_TYPE, QUESTION_MESSAGE_TYPE } from "../boundary/host-notifier.ts";
import { QUESTION_REMINDER_MESSAGE_TYPE, WAKE_MESSAGE_TYPE } from "../boundary/host-parent-wake.ts";
import { STOPPED_RUNS_MESSAGE_TYPE } from "../boundary/host-stopped-runs.ts";
import { presentAgentMessage } from "../ui/agent-message.ts";
import { presentSubagentNotification } from "../ui/notification.ts";
import type { WorkspaceSwept } from "../workspace/model.ts";

export const renderSubagentMessage: MessageRenderer = withCodePreviewMessageShell(
  presentSubagentNotification,
);

export const renderAgentMessageEntry: MessageRenderer =
  withCodePreviewMessageShell(presentAgentMessage);

export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(AGENT_MESSAGE_TYPE, renderAgentMessageEntry);
  for (const type of [
    COMPLETION_MESSAGE_TYPE,
    QUESTION_MESSAGE_TYPE,
    PROXY_NOTIFICATION_MESSAGE_TYPE,
    PEER_NOTICE_MESSAGE_TYPE,
    STOPPED_RUNS_MESSAGE_TYPE,
  ])
    pi.registerMessageRenderer(type, renderSubagentMessage);
}

const AgentId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const other = (relays: string): MessageOrigin => ({ author: "other", relays });
const subagentList = (ids: ReadonlyArray<string>): string =>
  `${ids.length === 1 ? "subagent" : "subagents"} ${Arr.join(ids, ", ")}`;

/**
 * Who writes each message this extension keeps in a root or child session's model context. Reports,
 * questions, and agent messages carry text other agents wrote; the rest is the extension's own.
 */
const SUBAGENT_MESSAGE_ORIGINS = {
  [COMPLETION_MESSAGE_TYPE]: originFromDetails(
    Schema.Struct({ ids: Schema.NonEmptyArray(AgentId) }),
    ({ ids }) => other(`reports and outcomes from ${subagentList(ids)}`),
    other("reports and outcomes from subagents"),
  ),
  [QUESTION_MESSAGE_TYPE]: originFromDetails(
    Schema.Struct({ id: AgentId }),
    ({ id }) => other(`a question from subagent ${id}`),
    other("a question from a subagent"),
  ),
  [AGENT_MESSAGE_TYPE]: originFromDetails(
    Schema.Struct({ from: AgentId }),
    ({ from }) => other(`a message from agent ${from}`),
    other("a message from another agent"),
  ),
  [QUESTION_REMINDER_MESSAGE_TYPE]: other("questions subagents are still waiting to have answered"),
  [PROXY_NOTIFICATION_MESSAGE_TYPE]: other(
    "an update about this agent's own subagents, with any reports or questions they wrote",
  ),
  [PEER_NOTICE_MESSAGE_TYPE]: other(
    "a workspace coordination notice that may quote the tasks of other subagents",
  ),
  [WAKE_MESSAGE_TYPE]: { author: "extension" },
  [STOPPED_RUNS_MESSAGE_TYPE]: { author: "extension" },
  [FINAL_REPORT_REMINDER_MESSAGE_TYPE]: { author: "extension" },
} as const;

/**
 * Marks this extension's messages in model requests so the model can tell them, and the agent text
 * they relay, from what the user typed. Root and child sessions each register once.
 */
export function registerSubagentMessageOrigins(pi: ExtensionAPI): void {
  registerMessageOrigins(pi, { extension: "pi-subagents", types: SUBAGENT_MESSAGE_ORIGINS });
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
