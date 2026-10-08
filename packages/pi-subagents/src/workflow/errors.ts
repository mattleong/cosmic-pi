import * as Schema from "effect/Schema";

/** Rejects the script's agent() promise: the call itself is invalid. */
export class WorkflowAgentCallError extends Schema.TaggedError<WorkflowAgentCallError>()(
  "WorkflowAgentCallError",
  { message: Schema.String },
) {}

/** The run or agent a request names isn't one this session runs or remembers. */
export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { message: Schema.String },
) {}

/** Where args don't match a workflow's `meta.args` schema, and what the schema wanted there. */
export const WorkflowArgsProblem = Schema.Struct({ path: Schema.String, problem: Schema.String });
export type WorkflowArgsProblem = typeof WorkflowArgsProblem.Type;

/**
 * A start request nothing ran for, such as oversized args, args that don't match the script's
 * `meta.args` (`argsProblems` lists where), or an unknown run to resume. A nested `workflow()`
 * call whose args don't match fails with `args_mismatch` too.
 */
export class WorkflowRequestError extends Schema.TaggedError<WorkflowRequestError>()(
  "WorkflowRequestError",
  {
    /** Why the request ran nothing. */
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
