import * as Schema from "effect/Schema";

/** Refusals retain their identity through the SDK's Promise-shaped tool boundary. */
export class FixtureBoundaryError extends Schema.TaggedError<FixtureBoundaryError>()(
  "FixtureBoundaryError",
  {},
) {
  override get message(): string {
    return "Evaluation tools allow read-only access inside the fixture directory only.";
  }
}

/** No host paths, provider errors, credentials, or tool output enter evaluator failures. */
export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  operation: Schema.Literals([
    "fixture",
    "dispatch",
    "setup",
    "create",
    "activate",
    "prompt",
    "abort",
    "shutdown",
    "dispose",
    "lifecycle",
    "budget",
    "model",
    "preflight",
    "artifact",
  ]),
  message: Schema.String,
}) {}

export const evaluationError = (
  operation: EvaluationError["operation"],
  message = `Evaluation ${operation} failed.`,
): EvaluationError => new EvaluationError({ operation, message });
