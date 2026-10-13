import { StringEnum } from "@earendil-works/pi-ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Type, type Static } from "typebox";
import { NonEmptyText } from "../workflow/model.ts";
import { WORKFLOW_SCRIPT_MAX_CHARS } from "../workflow/script.ts";
import type { WorkflowStartRequest } from "../workflow/service.ts";
import type { WorkflowSourceRequest } from "../workflow/source.ts";

export const WORKFLOW_TOOL_NAME = "subagent_workflow";
export const WORKFLOW_TOOL_ACTIONS = ["start", "status", "stop", "list"] as const;
export type WorkflowToolAction = (typeof WORKFLOW_TOOL_ACTIONS)[number];

export const workflowToolAction = (args: {
  readonly action?: WorkflowToolAction | undefined;
  readonly script?: string | undefined;
  readonly name?: string | undefined;
  readonly scriptPath?: string | undefined;
}): WorkflowToolAction | undefined =>
  args.action ??
  (args.script !== undefined || args.name !== undefined || args.scriptPath !== undefined
    ? "start"
    : undefined);

const RUN_ID_MAX_CHARS = 128;
const PATH_MAX_CHARS = 4_096;
const BUDGET_MAX = Number.MAX_SAFE_INTEGER;

export const WorkflowToolParameters = Type.Object(
  {
    action: Type.Optional(
      StringEnum(WORKFLOW_TOOL_ACTIONS, {
        description:
          "start runs a script in the background (the default when script, name or scriptPath is given); status and stop take runId; list shows saved workflows and this session's runs.",
      }),
    ),
    script: Type.Optional(
      Type.String({
        description:
          "start: an inline workflow script, plain JavaScript beginning with `export const meta = {...}`.",
        minLength: 1,
        maxLength: WORKFLOW_SCRIPT_MAX_CHARS,
      }),
    ),
    name: Type.Optional(
      Type.String({ description: "start: a saved workflow name.", minLength: 1, maxLength: 64 }),
    ),
    scriptPath: Type.Optional(
      Type.String({
        description: "start: a .js workflow file, absolute or relative to the session directory.",
        minLength: 1,
        maxLength: PATH_MAX_CHARS,
      }),
    ),
    args: Type.Optional(
      Type.Unknown({ description: "start: any JSON value, given to the script as `args`." }),
    ),
    resumeFromRunId: Type.Optional(
      Type.String({
        description: "start: reuse the results of identical agent() calls from this earlier run.",
        minLength: 1,
        maxLength: RUN_ID_MAX_CHARS,
      }),
    ),
    budget: Type.Optional(
      Type.Integer({
        description:
          'start: an output-token admission ceiling, such as 500000 for "cap this at 500k". Running agents may overshoot it. Pass it whenever the user states a token limit for the work.',
        minimum: 1,
        maximum: BUDGET_MAX,
      }),
    ),
    runId: Type.Optional(
      Type.String({
        description: "status and stop: the workflow run id.",
        minLength: 1,
        maxLength: RUN_ID_MAX_CHARS,
      }),
    ),
  },
  { additionalProperties: false },
);

const StartInputSchema = Schema.Struct({
  action: Schema.optional(Schema.Literal("start")),
  script: Schema.optional(NonEmptyText(WORKFLOW_SCRIPT_MAX_CHARS)),
  name: Schema.optional(NonEmptyText(64)),
  scriptPath: Schema.optional(NonEmptyText(PATH_MAX_CHARS)),
  args: Schema.optional(Schema.Json),
  resumeFromRunId: Schema.optional(NonEmptyText(RUN_ID_MAX_CHARS)),
  budget: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(BUDGET_MAX)),
  ),
});
const RunInputSchema = Schema.Struct({
  action: Schema.Literals(["status", "stop"]),
  runId: NonEmptyText(RUN_ID_MAX_CHARS),
});
const ListInputSchema = Schema.Struct({ action: Schema.Literal("list") });
const decodeStart = Schema.decodeUnknownOption(StartInputSchema, { onExcessProperty: "error" });
const decodeRun = Schema.decodeUnknownOption(RunInputSchema, { onExcessProperty: "error" });
const decodeList = Schema.decodeUnknownOption(ListInputSchema, { onExcessProperty: "error" });

export type WorkflowToolRequest =
  | { readonly action: "start"; readonly start: WorkflowStartRequest }
  | { readonly action: "status" | "stop"; readonly runId: string }
  | { readonly action: "list" };

export class WorkflowToolInputError extends Schema.TaggedError<WorkflowToolInputError>()(
  "WorkflowToolInputError",
  { message: Schema.String },
) {}

const inputError = (message: string) => new WorkflowToolInputError({ message });

const startSource = (
  input: typeof StartInputSchema.Type,
): WorkflowSourceRequest | WorkflowToolInputError => {
  const given = [input.script, input.name, input.scriptPath].filter(
    (value) => value !== undefined,
  ).length;
  if (given !== 1)
    return inputError('action "start" needs exactly one of script, name, or scriptPath.');
  if (input.script !== undefined) return { kind: "inline", script: input.script };
  if (input.name !== undefined) return { kind: "saved", name: input.name };
  return { kind: "file", path: input.scriptPath ?? "" };
};

export type WorkflowToolArguments = Static<typeof WorkflowToolParameters>;

export const decodeWorkflowToolRequest = (
  input: WorkflowToolArguments,
): WorkflowToolRequest | WorkflowToolInputError => {
  const start = decodeStart(input);
  if (Option.isSome(start)) {
    const source = startSource(start.value);
    if (source instanceof WorkflowToolInputError) return source;
    const { args, resumeFromRunId, budget } = start.value;
    return {
      action: "start",
      start: {
        source,
        args: args ?? null,
        ...(resumeFromRunId !== undefined && { resumeFromRunId }),
        ...(budget !== undefined && { budget }),
      },
    };
  }
  const run = decodeRun(input);
  if (Option.isSome(run)) return run.value;
  if (Option.isSome(decodeList(input))) return { action: "list" };
  return inputError(
    'Invalid subagent_workflow arguments: "start" (the default action) takes script, name, or scriptPath with optional args, resumeFromRunId and budget (a positive whole number of output tokens); "status" and "stop" take only runId; "list" takes nothing else.',
  );
};

const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100_000),
);
const Label = Schema.String.check(Schema.isMaxLength(512));
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const WorkflowRunSummarySchema = Schema.Struct({
  id: Label,
  name: Label,
  state: Schema.Literals(["running", "stopping", "completed", "failed", "stopped", "interrupted"]),
  phases: Count,
  currentPhase: Schema.optional(Label),
  agents: Count,
  queued: Count,
  running: Count,
  failed: Count,
  stopped: Schema.optional(Count),
  skipped: Count,
  reused: Count,
  startedAt: Schema.Finite,
  endedAt: Schema.optional(Schema.Finite),
  failure: Schema.optional(Label),
  budgetFailure: Schema.optional(Schema.Struct({ spent: Tokens, total: Tokens })),
});
export type WorkflowRunSummary = typeof WorkflowRunSummarySchema.Type;

export const WorkflowToolDetailsSchema = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literals(WORKFLOW_TOOL_ACTIONS),
  run: Schema.optional(WorkflowRunSummarySchema),
  unchanged: Schema.optional(Schema.Boolean),
  saved: Schema.optional(Count),
  diagnostics: Schema.optional(Count),
  runs: Schema.optional(Count),
  issue: Schema.optional(
    Schema.Struct({ code: Label, message: Label, detail: Schema.optional(Schema.String) }),
  ),
});
export type WorkflowToolDetails = typeof WorkflowToolDetailsSchema.Type;
export const decodeWorkflowToolDetails = Schema.decodeUnknownOption(WorkflowToolDetailsSchema);
