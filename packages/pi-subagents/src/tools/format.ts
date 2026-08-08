import type { SubagentSelectionProvenance } from "../profiles/model.ts";
import type { SubagentRunView } from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { safeTextPrefix } from "../run/state.ts";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";
import type { SubagentRunCard } from "./details.ts";

export const selectionSourceLabel = (
  run: Pick<SubagentRunView, "selection"> | { readonly selection: SubagentSelectionProvenance },
): string => {
  const candidate =
    run.selection.candidateIndex === undefined
      ? ""
      : ` candidate ${run.selection.candidateIndex + 1}`;
  return `${run.selection.source}${candidate}`;
};

export const boundToolOutput = (text: string): string => {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const marker =
    "\n… [tool output truncated; narrow the request or query individual run IDs for the omitted content]";
  return `${safeTextPrefix(text, Math.max(0, MAX_TOOL_OUTPUT_CHARS - marker.length))}${marker}`;
};

export const formatToolModel = (model: string, effort: string, fastMode?: boolean): string =>
  `${sanitizeTerminalLine(model)}:${sanitizeTerminalLine(effort)}${fastMode ? " ⚡" : ""}`;

export const formatToolRoute = (
  host: string,
  runtime: string,
  model: string,
  effort: string,
  fastMode?: boolean,
): string =>
  `${sanitizeTerminalLine(host)}/${sanitizeTerminalLine(runtime)} · ${formatToolModel(model, effort, fastMode)}`;

export const joinBoundedToolText = (parts: ReadonlyArray<string>): string =>
  boundToolOutput(parts.filter(Boolean).join("\n\n"));

export const attentionRecoveryText = (runs: ReadonlyArray<SubagentRunCard>): string => {
  const waiting = runs.filter((run) => run.state === "waiting_for_parent" && run.question?.message);
  if (waiting.length === 0) return "";
  return [
    "Parent reply required; other unfinished subagents continue independently.",
    ...waiting.flatMap((run) => {
      const question = sanitizeTerminalLine(run.question?.message ?? "");
      const marker = "… [truncated]";
      const bounded =
        question.length <= 512
          ? question
          : `${safeTextPrefix(question, 512 - marker.length)}${marker}`;
      return [
        `Question from ${sanitizeTerminalLine(run.name)}: ${bounded}`,
        `Reply with subagent_reply({ runId: ${JSON.stringify(run.id)}, message: "..." }), then call subagent_await again.`,
      ];
    }),
  ].join("\n");
};
