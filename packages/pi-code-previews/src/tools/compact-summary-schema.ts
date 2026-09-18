import * as Schema from "effect/Schema";
import { CompactIssuesSchema } from "./compact-issues";

const Outcome = Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]);
const Labels = Schema.Array(Schema.String);
const FailureEvidence = Schema.Struct({
  code: Schema.String,
  cause: Schema.String,
  coverage: Schema.Literals(["complete", "unknown"]),
});
const Notices = Schema.Array(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    kind: Schema.Literals(["warning", "error", "recovery"]),
    text: Schema.String,
    expandedOnly: Schema.optionalKey(Schema.Literal(true)),
    expandedInResult: Schema.optionalKey(Schema.Literal(true)),
  }),
);
const Fields = {
  action: Schema.optionalKey(Schema.String),
  counters: Schema.optionalKey(Labels),
  metadata: Schema.optionalKey(Labels),
  outcome: Schema.optionalKey(Outcome),
  notices: Schema.optionalKey(Notices),
  issues: Schema.optionalKey(CompactIssuesSchema),
  failureEvidence: Schema.optionalKey(FailureEvidence),
  showTiming: Schema.optionalKey(Schema.Literal(true)),
};
const Summary = Schema.Struct({
  ...Fields,
  subject: Schema.String,
  detailsOnExpand: Schema.optionalKey(Schema.Literal(true)),
  expandedResultOwnsCall: Schema.optionalKey(Schema.Literal(true)),
  failure: Schema.optionalKey(Schema.Struct({ cause: Schema.String, details: Schema.String })),
  children: Schema.optionalKey(
    Schema.Struct({
      total: Schema.Natural,
      entries: Schema.Array(
        Schema.Struct({
          ...Fields,
          label: Schema.String,
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
  try {
    return isSummary(value);
  } catch {
    return false;
  }
}
