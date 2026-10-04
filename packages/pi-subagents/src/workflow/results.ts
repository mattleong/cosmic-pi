import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { safeTextPrefix } from "pi-cosmic-core";
import { canonicalResultJson } from "../domain/result-contract.ts";
import type { SubagentUsage } from "../run/model.ts";
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
  /** The writer's worktree held no changes and was discarded, so it awaits no review. */
  readonly unchanged?: true | undefined;
  /** A completed call's resume key, which a later run replays it by. */
  readonly key?: string | undefined;
  /**
   * Output tokens the run's budget counted for a live call, its agent's own subagents included; a
   * reused result carries its earlier count, though this run's budget counted none.
   */
  readonly outputTokens: number;
  /** What a live call used in this run; a reused result costs nothing and has none. */
  readonly usage?: SubagentUsage | undefined;
  /** Tool calls a live call's agent started. */
  readonly toolUses?: number | undefined;
  /** How long a live call's agent ran, once it started. */
  readonly durationMs?: number | undefined;
  readonly result: Schema.Json;
  /**
   * The file in the run's directory holding the full value of a result too long for the line,
   * which then carries only its head.
   */
  readonly resultFile?: string | undefined;
  /** Set to false when such a result's file couldn't be saved, so a resume runs the call again. */
  readonly replayable?: false | undefined;
}

/**
 * The canonical JSON of a result too long for its journal line, which a file beside the journal
 * keeps in full; undefined when the line carries the result verbatim.
 */
export const workflowResultOverflow = (result: Schema.Json): string | undefined => {
  const json = canonicalResultJson(result);
  return json.length > WORKFLOW_RESULT_LINE_MAX_CHARS ? json : undefined;
};

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

/** Usage as a line records it: input, output and total tokens, and the cost when known. */
const lineUsage = (usage: SubagentUsage) => ({
  input: usage.input,
  output: usage.output,
  total: usage.totalTokens,
  ...(usage.cost !== undefined && { cost: usage.cost }),
});

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

/**
 * What a later run reads back from a line; the rest, such as usage, tool uses and duration, is for
 * the main agent, so lines with or without those fields read the same.
 */
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

/** A completed call a resume can reuse. */
export interface WorkflowReplayLine {
  readonly key: string;
  readonly label?: string | undefined;
  readonly runId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly outputTokens: number;
  /** The full result, unless `resultFile` names the file that holds it. */
  readonly result: Schema.Json;
  readonly resultFile?: string | undefined;
}

/** What a run's results journal tells a later Pi process. */
export interface WorkflowJournalReading {
  /** Calls that completed with a result, live or reused. */
  readonly finished: number;
  /** Worktrees the lines name, in journal order, other than those discarded as unchanged. */
  readonly workspaces: ReadonlyArray<string>;
  readonly replayable: ReadonlyArray<WorkflowReplayLine>;
}

type ReadLine = typeof ReadLineSchema.Type;

/**
 * A completed line's replay, or undefined when it has no key or lacks its full value. A writer
 * whose worktree held no changes replays like a reader: nothing of its awaits review.
 */
const replayLine = (line: ReadLine): WorkflowReplayLine | undefined => {
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

/** Reads a results journal's lines; malformed ones are skipped. */
export const readWorkflowResultLines = (lines: ReadonlyArray<string>): WorkflowJournalReading => {
  const read = lines.flatMap((text) => Option.toArray(decodeReadLine(text)));
  const completed = read.filter((line) => line.state === "completed");
  return {
    finished: completed.length,
    workspaces: [
      ...new Set(
        read.flatMap((line) =>
          line.workspaceId === undefined || line.unchanged === true ? [] : [line.workspaceId],
        ),
      ),
    ],
    replayable: completed.flatMap((line) => {
      const replay = replayLine(line);
      return replay === undefined ? [] : [replay];
    }),
  };
};
