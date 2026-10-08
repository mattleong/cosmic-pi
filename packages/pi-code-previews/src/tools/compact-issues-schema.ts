import * as Schema from "effect/Schema";
import { COMPACT_ISSUE_MESSAGE_LIMIT, CompactIssueSchema } from "./compact-issues";

/** Retained evidence for receipts crossing a package boundary. Overflow rejects the receipt. */
export function createBoundedCompactIssuesSchema(limits: {
  maxTextLength: number;
  maxEntries: number;
}) {
  const text = Schema.String.check(Schema.isMaxLength(limits.maxTextLength));
  return Schema.Array(
    Schema.Struct({
      severity: CompactIssueSchema.fields.severity,
      code: text.check(Schema.isMinLength(1)),
      message: Schema.String.check(
        Schema.isMaxLength(Math.min(COMPACT_ISSUE_MESSAGE_LIMIT, limits.maxTextLength)),
      ),
      detail: Schema.optionalKey(text),
    }),
  ).check(Schema.isMaxLength(limits.maxEntries));
}
