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

export const formatTokenCount = (tokens: number): string => {
  const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}m`;
};

export const formatCost = (cost: number): string => {
  const value = Number.isFinite(cost) ? Math.max(0, cost) : 0;
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
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

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

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
