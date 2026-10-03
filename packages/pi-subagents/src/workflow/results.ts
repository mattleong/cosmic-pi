import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { safeTextPrefix } from "pi-cosmic-core";
import { canonicalResultJson } from "../domain/result-contract.ts";
import type { WorkflowAgentState } from "./model.ts";

/** Canonical JSON one journal line may carry as an agent's result. */
export const WORKFLOW_RESULT_LINE_MAX_CHARS = 32 * 1024;

/** One finished agent() call as the run's results journal records it. */
export interface WorkflowResultLine {
  /** The live call's position; reused results have none. */
  readonly callId?: number | undefined;
  readonly label: string;
  readonly phase?: string | undefined;
  readonly profile?: string | undefined;
  readonly state: Exclude<WorkflowAgentState, "queued" | "running">;
  readonly reason?: string | undefined;
  readonly reused?: boolean | undefined;
  /** The subagent run that produced the result; a reused result names the earlier run's agent. */
  readonly runId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly outputTokens: number;
  readonly result: Schema.Json;
}

/**
 * The result as a line carries it: verbatim within {@link WORKFLOW_RESULT_LINE_MAX_CHARS} of
 * canonical JSON, otherwise the head of the text, or of a value's JSON, marked as truncated.
 */
const boundedResult = (result: Schema.Json) => {
  const json = canonicalResultJson(result);
  if (json.length <= WORKFLOW_RESULT_LINE_MAX_CHARS) return { result };
  const text = Predicate.isString(result) ? result : json;
  // Escapes can lengthen text, so shrink the head until its canonical JSON fits.
  let head = safeTextPrefix(text, WORKFLOW_RESULT_LINE_MAX_CHARS);
  while (canonicalResultJson(head).length > WORKFLOW_RESULT_LINE_MAX_CHARS)
    head = safeTextPrefix(head, Math.floor(head.length * 0.9));
  return { result: head, resultTruncated: true, resultChars: text.length };
};

/** The journal line for one finished call, without its newline. */
export const workflowResultJsonLine = (line: WorkflowResultLine): string =>
  JSON.stringify({
    ...(line.callId !== undefined && { callId: line.callId }),
    label: line.label,
    ...(line.phase !== undefined && { phase: line.phase }),
    ...(line.profile !== undefined && { profile: line.profile }),
    state: line.state,
    ...(line.reason !== undefined && { reason: line.reason }),
    ...(line.reused === true && { reused: true }),
    ...(line.runId !== undefined && { runId: line.runId }),
    ...(line.workspaceId !== undefined && { workspaceId: line.workspaceId }),
    outputTokens: line.outputTokens,
    ...boundedResult(line.result),
  });
