import type { RunRecord } from "./internal.ts";
import { isActiveRunState } from "./model.ts";
import { safeTextPrefix } from "./state.ts";

const activePeerLines = (records: Iterable<RunRecord>, selfId?: string): string[] =>
  [...records]
    .filter((record) => record.view.id !== selfId && isActiveRunState(record.view.state))
    .map(
      (record) =>
        `- ${record.view.name} (${record.view.id}): ${record.view.writeIntent}; ${record.view.state}; task: ${safeTextPrefix(record.view.task, 160)}`,
    );

export const peerNoticeText = (records: Iterable<RunRecord>, selfId: string): string => {
  const peers = activePeerLines(records, selfId);
  if (peers.length === 0) return "You are currently the only active subagent in this workspace.";
  return [
    `You share this working directory with ${peers.length} other active subagent${peers.length === 1 ? "" : "s"}:`,
    "",
    ...peers,
    "",
    "The parent owns coordination. Do not edit unless your task explicitly declares writer intent. There is only one shared-workspace writer. Contact the parent before work that could overlap another task.",
  ].join("\n");
};
