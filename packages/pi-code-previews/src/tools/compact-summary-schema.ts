import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { CompactIssueSchema } from "./compact-issues";

export const CompactOutcomeSchema = Schema.Literals([
  "success",
  "returned",
  "warning",
  "error",
  "cancelled",
  "uncertain",
]);
const Labels = Schema.Array(Schema.String);
const Fields = {
  compactSubject: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  counters: Schema.optionalKey(Labels),
  metadata: Schema.optionalKey(Labels),
  showTiming: Schema.optionalKey(Schema.Literal(true)),
  showShortTiming: Schema.optionalKey(Schema.Literal(true)),
  issues: Schema.optionalKey(Schema.Array(CompactIssueSchema)),
};
const Summary = Schema.Struct({
  ...Fields,
  subject: Schema.String,
  outcome: Schema.optionalKey(CompactOutcomeSchema),
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
          status: Schema.Literals(["pending", "running", ...CompactOutcomeSchema.literals]),
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
