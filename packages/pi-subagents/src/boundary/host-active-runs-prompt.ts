import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clipText, sanitizeTerminalLine } from "pi-cosmic-core";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { isActiveRunState } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";

export const ACTIVE_RUNS_PROMPT_SECTION = "active_subagents";
const MAX_LISTED_RUNS = 20;

const stateLabel = (run: SubagentRunView): string =>
  run.state === "waiting_for_parent"
    ? "waiting for your reply"
    : run.state === "paused"
      ? "paused"
      : "running";

const runLine = (run: SubagentRunView): string =>
  `- ${run.id} · ${run.profile ?? "subagent"} · ${clipText(sanitizeTerminalLine(run.name), 60)} · ${stateLabel(run)}`;

/**
 * Lists the direct children still active, so the parent remembers them after compaction instead of
 * launching duplicates. Only identity and coarse state appear: the section must stay byte-identical
 * while nothing changes, or every turn would patch the system prompt.
 */
export const activeRunsSection = (projection: SubagentProjection): string | undefined => {
  const active = projection.runs.filter(
    (run) => run.parentRunId === undefined && isActiveRunState(run.state),
  );
  if (active.length === 0) return undefined;
  const listed = active.slice(0, MAX_LISTED_RUNS).map(runLine);
  const more = active.length - listed.length;
  return [
    "Subagents you started that are still active. Their reports arrive on their own; check subagent_status before starting work that may duplicate theirs.",
    ...listed,
    ...(more > 0 ? [`- and ${more} more; see subagent_list`] : []),
  ].join("\n");
};

export const registerActiveRunsPrompt = (
  pi: ExtensionAPI,
  projection: () => SubagentProjection | undefined,
): void => {
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    const current = projection();
    const section =
      current && options.selectedTools.includes(SUBAGENT_TOOL_NAME.start)
        ? activeRunsSection(current)
        : undefined;
    if (section) options.sections[ACTIVE_RUNS_PROMPT_SECTION] = section;
    else delete options.sections[ACTIVE_RUNS_PROMPT_SECTION];
    return undefined;
  });
};
