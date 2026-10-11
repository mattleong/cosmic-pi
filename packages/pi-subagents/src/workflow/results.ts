import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { safeTextPrefix } from "pi-cosmic-core";
import { canonicalResultJson } from "../domain/result-contract.ts";
import type { SubagentUsage } from "../run/model.ts";
import type { WorkflowAgentState } from "./model.ts";

export const WORKFLOW_RESULT_LINE_MAX_CHARS = 32 * 1024;

export interface WorkflowResultLine {
  readonly callId?: number | undefined;
  readonly label: string;
  readonly phase?: string | undefined;
  readonly profile?: string | undefined;
  readonly state: Exclude<WorkflowAgentState, "queued" | "running">;
  readonly reason?: string | undefined;
  readonly reused?: boolean | undefined;
  readonly runId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly unchanged?: true | undefined;
  readonly key?: string | undefined;
  readonly outputTokens: number;
  readonly usage?: SubagentUsage | undefined;
  readonly toolUses?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly result: Schema.Json;
  readonly resultFile?: string | undefined;
  readonly replayable?: false | undefined;
}

export const workflowResultOverflow = (result: Schema.Json): string | undefined => {
  const json = canonicalResultJson(result);
  return json.length > WORKFLOW_RESULT_LINE_MAX_CHARS ? json : undefined;
};

const boundedResult = (result: Schema.Json) => {
  const json = canonicalResultJson(result);
  if (json.length <= WORKFLOW_RESULT_LINE_MAX_CHARS) return { result };
  const text = Predicate.isString(result) ? result : json;
  let head = safeTextPrefix(text, WORKFLOW_RESULT_LINE_MAX_CHARS);
  while (canonicalResultJson(head).length > WORKFLOW_RESULT_LINE_MAX_CHARS)
    head = safeTextPrefix(head, Math.floor(head.length * 0.9));
  return { result: head, resultTruncated: true, resultChars: text.length };
};

const lineUsage = (usage: SubagentUsage) => ({
  input: usage.input,
  output: usage.output,
  total: usage.totalTokens,
  ...(usage.cost !== undefined && { cost: usage.cost }),
});

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
    ...(line.unchanged === true && { unchanged: true }),
    ...(line.key !== undefined && { key: line.key }),
    outputTokens: line.outputTokens,
    ...(line.usage !== undefined && { usage: lineUsage(line.usage) }),
    ...(line.toolUses !== undefined && { toolUses: line.toolUses }),
    ...(line.durationMs !== undefined && { durationMs: line.durationMs }),
    ...boundedResult(line.result),
    ...(line.resultFile !== undefined && { resultFile: line.resultFile }),
    ...(line.replayable === false && { replayable: false }),
  });

const Tokens = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const ReadLineSchema = Schema.Struct({
  state: Schema.String,
  label: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  unchanged: Schema.optional(Schema.Boolean),
  key: Schema.optional(Schema.String),
  outputTokens: Tokens,
  result: Schema.Json,
  resultTruncated: Schema.optional(Schema.Boolean),
  resultFile: Schema.optional(Schema.String),
  replayable: Schema.optional(Schema.Boolean),
});
const decodeReadLine = Schema.decodeUnknownOption(Schema.fromJsonString(ReadLineSchema));

export interface WorkflowReplayLine {
  readonly key: string;
  readonly label?: string | undefined;
  readonly runId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly outputTokens: number;
  readonly result: Schema.Json;
  readonly resultFile?: string | undefined;
}

const replayLine = (line: typeof ReadLineSchema.Type): WorkflowReplayLine | undefined => {
  if (line.key === undefined || line.replayable === false) return undefined;
  if (line.resultTruncated === true && line.resultFile === undefined) return undefined;
  return {
    key: line.key,
    ...(line.label !== undefined && { label: line.label }),
    ...(line.runId !== undefined && { runId: line.runId }),
    ...(line.workspaceId !== undefined &&
      line.unchanged !== true && { workspaceId: line.workspaceId }),
    outputTokens: line.outputTokens,
    result: line.result,
    ...(line.resultTruncated === true && { resultFile: line.resultFile }),
  };
};

export const readWorkflowResultLines = (lines: ReadonlyArray<string>) => {
  const read = lines.flatMap((text) => Option.toArray(decodeReadLine(text)));
  const completed = read.filter((line) => line.state === "completed");
  return {
    finished: completed.length,
    workspaces: [
      ...new Set(read.flatMap((line) => (line.unchanged === true ? [] : (line.workspaceId ?? [])))),
    ],
    replayable: completed.flatMap((line) => replayLine(line) ?? []),
  };
};
