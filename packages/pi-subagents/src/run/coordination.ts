import { isActiveRunState, type StartSubagentRequest, type SubagentWriteIntent } from "./model.ts";
import type { RunRecord } from "./internal.ts";
import { safeTextPrefix } from "./state.ts";

const PI_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
]);

export const piToolsForWriteIntent = (
  activeTools: ReadonlyArray<string>,
  writeIntent: SubagentWriteIntent,
): ReadonlyArray<string> =>
  [...new Set(activeTools)].filter(
    (tool) => writeIntent === "writer" || PI_READ_ONLY_TOOLS.has(tool),
  );

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

export const childSystemPrompt = (request: StartSubagentRequest): string =>
  [
    "You are a subagent working for a supervising Pi session.",
    "Complete the assigned task directly. The parent owns orchestration, task partitioning, and final decisions.",
    "Do not launch or propose additional subagents.",
    ...(request.backend === "claude-cli"
      ? [
          "Before changing or reviewing files, read and follow applicable AGENTS.md instructions in the workspace.",
        ]
      : []),
    ...(request.backend === "pi"
      ? [
          "Use contact_parent(kind=progress) only for meaningful progress or discoveries that change the plan.",
          "Use contact_parent(kind=question) when blocked on a decision; wait for the parent reply instead of guessing.",
          "Use contact_parent(kind=warning) for a material non-blocking risk.",
        ]
      : [
          "This backend cannot contact the parent during the run. If blocked, stop and explain the blocker in the final report rather than guessing.",
        ]),
    "Always end with a concise, self-contained final report containing the actual findings or work completed. Never finish with only an acknowledgement.",
    request.writeIntent === "writer"
      ? "You are the sole declared writer in the shared working directory. Keep edits narrowly within the assigned task and report changed files and validation."
      : "Your run is declared read-only. Use the available inspection tools, but do not edit, write, patch, generate, or otherwise mutate project files.",
  ].join("\n\n");

export const taskPrompt = (request: StartSubagentRequest, peerNotice: string): string =>
  [`Assigned task:\n${request.task}`, `Workspace coordination:\n${peerNotice}`].join("\n\n");
