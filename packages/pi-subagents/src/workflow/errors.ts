import * as Schema from "effect/Schema";

export class WorkflowAgentCallError extends Schema.TaggedError<WorkflowAgentCallError>()(
  "WorkflowAgentCallError",
  { message: Schema.String },
) {}

export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { message: Schema.String },
) {}

export const WorkflowArgsProblem = Schema.Struct({ path: Schema.String, problem: Schema.String });
export type WorkflowArgsProblem = typeof WorkflowArgsProblem.Type;

export class WorkflowRequestError extends Schema.TaggedError<WorkflowRequestError>()(
  "WorkflowRequestError",
  {
    code: Schema.Literals([
      "args_too_large",
      "args_mismatch",
      "resume_running",
      "resume_running_elsewhere",
      "resume_unrecorded",
      "resume_unknown",
      "resume_other_session",
      "resume_unreadable",
    ]),
    message: Schema.String,
    argsProblems: Schema.optional(Schema.Array(WorkflowArgsProblem)),
  },
) {}

export const workflowRequestError = (
  code: WorkflowRequestError["code"],
  message: string,
  argsProblems?: ReadonlyArray<WorkflowArgsProblem>,
) => new WorkflowRequestError({ code, message, ...(argsProblems && { argsProblems }) });
