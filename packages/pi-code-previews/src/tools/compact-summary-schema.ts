import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { CompactIssuesSchema, CompactIssueClaimSchema } from "./compact-issues";

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
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(240))),
    expandedOnly: Schema.optionalKey(Schema.Literal(true)),
  }),
);
const Fields = {
  compactSubject: Schema.optionalKey(Schema.String),
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
  expandedResultOwnsIssues: Schema.optionalKey(Schema.Array(CompactIssueClaimSchema)),
  failure: Schema.optionalKey(
    Schema.Struct({
      cause: Schema.String,
      description: Schema.optional(Schema.String.check(Schema.isMaxLength(240))),
      details: Schema.String,
      ownedIssues: Schema.optionalKey(Schema.Array(CompactIssueClaimSchema)),
    }),
  ),
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
  return invokeHostCallback(() => isSummary(value), false);
}
