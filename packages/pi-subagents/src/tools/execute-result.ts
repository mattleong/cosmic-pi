import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import { encodeSubagentContract, type SubagentContract } from "./contract-schema.ts";
import { makeAwaitDetails, makeCompactToolDetails, makeStartDetails } from "./details.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import {
  boundToolOutput,
  formatActionFailures,
  formatDetailedRuns,
  formatRun,
  formatStartResult,
  joinBoundedToolText,
  managementAcknowledgement,
} from "./format.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import { subagentToolAction, type SubagentToolInput } from "./schema.ts";

export interface SubagentExecutionResult {
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly awaitContextRuns?: ReadonlyArray<SubagentRunView>;
  readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
  readonly startEntries?: ReadonlyArray<SubagentStartEntry>;
  readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
  readonly attentionRequired?: boolean;
  readonly text?: string;
  readonly contract?: SubagentContract;
}

/** Three independent projections: human text, persisted display details, and script data. */
export const presentSubagentResult = (
  input: Exclude<SubagentToolInput, { readonly tool: "subagent_models" | "subagent_workspace" }>,
  executionResult: SubagentExecutionResult,
  requestedAwaitIds?: ReadonlyArray<string>,
): AgentToolResult<unknown> => {
  const { runs, awaitContextRuns, attentionRequired, text: formattedText } = executionResult;
  const startFailures = executionResult.startFailures ?? [];
  const actionFailures = executionResult.actionFailures ?? [];
  const details: unknown =
    input.tool === SUBAGENT_TOOL_NAME.start
      ? makeStartDetails({
          startEntries: executionResult.startEntries ?? [],
          ...(startFailures.length > 0 && { startFailures }),
        })
      : input.tool === SUBAGENT_TOOL_NAME.await
        ? makeAwaitDetails({
            runs,
            contextRuns: awaitContextRuns,
            awaitedRunIds: requestedAwaitIds,
            awaitUntil: input.args.until,
            ...(attentionRequired === true && { attentionRequired: true as const }),
          })
        : makeCompactToolDetails({
            action: subagentToolAction(input),
            runs,
            ...(actionFailures.length > 0 && { actionFailures }),
          });
  const detailedText = () => formattedText ?? formatDetailedRuns(runs).text;
  const resultText = (): string => {
    if (input.tool === SUBAGENT_TOOL_NAME.start)
      return formattedText ?? formatStartResult(runs, startFailures);
    const acknowledgement = () =>
      managementAcknowledgement(
        subagentToolAction(input),
        runs,
        input.tool === SUBAGENT_TOOL_NAME.claims ? input.args.action : undefined,
      );
    if (actionFailures.length > 0)
      return input.tool === SUBAGENT_TOOL_NAME.status
        ? detailedText()
        : joinBoundedToolText([
            acknowledgement(),
            formatActionFailures(subagentToolAction(input), actionFailures),
          ]);
    if (runs.length === 0) return "No subagent runs.";
    switch (input.tool) {
      case SUBAGENT_TOOL_NAME.list:
        return projectRunCardTree(runs)
          .map((row) => `${runTreeBranch(row)}${formatRun(row.run)}`)
          .join("\n");
      case SUBAGENT_TOOL_NAME.status:
      case SUBAGENT_TOOL_NAME.await:
        return detailedText();
      default:
        return acknowledgement();
    }
  };
  return {
    content: [{ type: "text", text: boundToolOutput(resultText()) }],
    details,
    ...(executionResult.contract && {
      structuredContent: encodeSubagentContract(executionResult.contract),
    }),
  };
};
