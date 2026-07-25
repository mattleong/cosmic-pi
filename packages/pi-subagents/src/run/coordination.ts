import { isActiveRunState, type StartSubagentRequest } from "./model.ts";
import type { RunRecord } from "./internal.ts";

const activePeerLines = (records: Iterable<RunRecord>, selfId?: string): string[] =>
  [...records]
    .filter((record) => record.view.id !== selfId && isActiveRunState(record.view.state))
    .map(
      (record) =>
        `- ${record.view.name} (${record.view.id}): ${record.view.writeIntent}; ${record.view.state}; task: ${record.view.task.slice(0, 160)}`,
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

export const childSystemPrompt = (request: StartSubagentRequest): string =>
  [
    "You are a subagent working for a supervising Pi session.",
    "Complete the assigned task directly. The parent owns orchestration, task partitioning, and final decisions.",
    "Do not launch or propose additional subagents.",
    "Use contact_parent(kind=progress) only for meaningful progress or discoveries that change the plan.",
    "Use contact_parent(kind=question) when blocked on a decision; wait for the parent reply instead of guessing.",
    "Use contact_parent(kind=warning) for a material non-blocking risk.",
    "Always end with a concise, self-contained final report containing the actual findings or work completed, even if you already sent them through contact_parent. Never finish with only an acknowledgement or 'findings sent to parent'.",
    request.writeIntent === "writer"
      ? "You are the sole declared writer in the shared working directory. Keep edits narrowly within the assigned task and report changed files and validation."
      : "Your run is declared read-only. You have full tools for inspection, but you must not edit, write, patch, generate, or otherwise mutate project files.",
  ].join("\n\n");

export const taskPrompt = (request: StartSubagentRequest, peerNotice: string): string =>
  [`Assigned task:\n${request.task}`, `Workspace coordination:\n${peerNotice}`].join("\n\n");
