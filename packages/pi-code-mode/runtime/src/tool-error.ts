import { Schema } from "effect";

/** Safe operational refusal from a standard tool pack, reported as `ToolFailure`. */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Creates a tool refusal whose message is safe to include in an execution diagnostic. */
export const toolError = (message: string, cause?: unknown): ToolError =>
  new ToolError(
    (() => {
      const objectPart458_0 = { message };
      const objectPart458_1 = cause === undefined ? objectPart458_0 : { ...objectPart458_0, cause };
      return objectPart458_1;
    })(),
  );
