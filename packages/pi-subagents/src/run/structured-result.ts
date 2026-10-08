import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BackendEvent } from "../backend/model.ts";
import { canonicalResultJson } from "../domain/result-contract.ts";
import { isInactiveRunRecord, type RunRecord, type WithRunLock } from "./internal.ts";

type StructuredResultEvent = Extract<BackendEvent, { readonly type: "structured_result" }>;

/** Why a submitted result was refused; the child's model sees the message and can correct. */
class StructuredResultRejected extends Schema.TaggedError<StructuredResultRejected>()(
  "StructuredResultRejected",
  { message: Schema.String },
) {}

const decodeSubmittedJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const rejected = (message: string) => new StructuredResultRejected({ message });

/** Validates a submission against the run's contract and returns its canonical JSON. */
const validate = (
  record: RunRecord,
  valueJson: string,
): Effect.Effect<string, StructuredResultRejected> => {
  const contract = record.launch.resultContract;
  if (!contract) return Effect.fail(rejected("This subagent has no result contract."));
  const submitted = decodeSubmittedJson(valueJson);
  if (Option.isNone(submitted)) return Effect.fail(rejected("The result is not valid JSON."));
  return contract.decode(submitted.value).pipe(
    Effect.mapBoth({
      onFailure: (error) => rejected(`The result does not match its schema:\n${error.message}`),
      onSuccess: canonicalResultJson,
    }),
  );
};

/**
 * Records the first valid result of the current assignment; caller holds the run lock. Once a
 * pause commits, the assignment accepts nothing more; a resume starts one that asks again.
 */
const acceptLocked = (
  record: RunRecord,
  assignmentEpoch: number,
  json: string,
): Effect.Effect<void, StructuredResultRejected> => {
  if (
    isInactiveRunRecord(record) ||
    record.assignment.epoch !== assignmentEpoch ||
    record.pausedAssignmentEpoch === assignmentEpoch ||
    (record.assignment.phase !== "running" && record.assignment.phase !== "issuing")
  )
    return Effect.fail(
      rejected("This assignment is no longer running, so the result was not accepted."),
    );
  if (record.structuredResult?.assignmentEpoch === assignmentEpoch)
    return Effect.fail(
      rejected("A result was already accepted for this run, and the first one is final. Stop now."),
    );
  record.structuredResult = { assignmentEpoch, json };
  return Effect.void;
};

/**
 * Answers a local child's result submission. The child waits for this answer before its tool
 * returns, so an accepted value is stored before the assignment's settlement arrives.
 */
export function makeRunStructuredResults(dependencies: { readonly withLock: WithRunLock }) {
  const { withLock } = dependencies;
  return (record: RunRecord, event: StructuredResultEvent): Effect.Effect<void> =>
    validate(record, event.valueJson).pipe(
      Effect.flatMap((json) => withLock(acceptLocked(record, event.assignmentEpoch, json))),
      Effect.matchEffect({
        onFailure: (error) => event.respond(false, error.message),
        onSuccess: () => event.respond(true),
      }),
      Effect.ignore,
    );
}

export type RunStructuredResults = ReturnType<typeof makeRunStructuredResults>;
