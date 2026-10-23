import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { encodeSubagentContract, type SubagentContract } from "./contract-schema.ts";
import { awaitDetails, compactToolDetails, startDetails } from "./details.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import { boundToolOutput, formatActionFailures, formatStartResult } from "./format.ts";
import { managementAcknowledgement } from "./format-acknowledgement.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import { awaitUntil, subagentToolAction, type SubagentToolInput } from "./schema.ts";

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

export const presentSubagentResult = (
  input: Exclude<
    SubagentToolInput,
    { readonly tool: typeof SUBAGENT_TOOL_NAME.models | typeof SUBAGENT_TOOL_NAME.workspace }
  >,
  executionResult: SubagentExecutionResult,
  requestedAwaitIds?: ReadonlyArray<string>,
): AgentToolResult<unknown> => {
  const { runs, awaitContextRuns, attentionRequired, text: formattedText } = executionResult;
  const startFailures = executionResult.startFailures ?? [];
  const actionFailures = executionResult.actionFailures ?? [];
  const details: unknown =
    input.tool === SUBAGENT_TOOL_NAME.start
      ? startDetails({
          startEntries: executionResult.startEntries ?? [],
          ...(startFailures.length > 0 && { startFailures }),
        })
      : input.tool === SUBAGENT_TOOL_NAME.await
        ? awaitDetails({
            runs,
            contextRuns: awaitContextRuns,
            awaitedRunIds: requestedAwaitIds,
            awaitUntil: awaitUntil(input.args),
            ...(attentionRequired === true && { attentionRequired: true as const }),
          })
        : compactToolDetails({
            action: subagentToolAction(input),
            runs,
            ...(actionFailures.length > 0 && { actionFailures }),
          });
  // Each part bounds every run's share, so the guard below never cuts a delivered outcome.
  const resultText = (): string => {
    if (input.tool === SUBAGENT_TOOL_NAME.start)
      return formattedText ?? formatStartResult(runs, startFailures);
    if (formattedText !== undefined) return formattedText;
    // An await always brings its text, so only a lifecycle result is composed here.
    const acknowledgement =
      input.tool === SUBAGENT_TOOL_NAME.lifecycle
        ? managementAcknowledgement(input.args.action, runs)
        : "";
    if (actionFailures.length > 0)
      return [acknowledgement, formatActionFailures(actionFailures)].filter(Boolean).join("\n\n");
    return acknowledgement || "No subagent runs.";
  };
  return {
    content: [{ type: "text", text: boundToolOutput(resultText()) }],
    details,
    ...(executionResult.contract && {
      structuredContent: encodeSubagentContract(executionResult.contract),
    }),
  };
};
