import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { CompactIssueSchema } from "./compact-issues";

const Outcome = Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]);
const Labels = Schema.Array(Schema.String);
const Issues = Schema.Array(CompactIssueSchema);
const Fields = {
  compactSubject: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  counters: Schema.optionalKey(Labels),
  metadata: Schema.optionalKey(Labels),
  showTiming: Schema.optionalKey(Schema.Literal(true)),
  issues: Schema.optionalKey(Issues),
};
const Summary = Schema.Struct({
  ...Fields,
  subject: Schema.String,
  outcome: Schema.optionalKey(Outcome),
  children: Schema.optionalKey(
    Schema.Struct({
      total: Schema.Natural,
      entries: Schema.Array(
        Schema.Struct({
          ...Fields,
          label: Schema.String,
          returnedCheckmark: Schema.optionalKey(Schema.Literal(true)),
          subject: Schema.optionalKey(Schema.String),
          durationMs: Schema.optionalKey(Schema.Finite),
          status: Schema.Literals([
            "pending",
            "running",
            "returned",
            "success",
            "warning",
            "error",
            "cancelled",
            "uncertain",
          ]),
        }),
      ),
    }),
  ),
});

const isSummary = Schema.is(Summary);

/** Reject malformed provider evidence before it can hide original results. */
export function isSafeCompactSummary<Value>(value: Value): boolean {
  return invokeHostCallback(() => isSummary(value), false);
}
