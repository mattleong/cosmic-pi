import * as Schema from "effect/Schema";
import { clampModelVisibleText } from "../tools/limits.ts";
import type { ExecutionOutcome } from "./model.ts";

export const resultReadFailures = {
  "invalid-input": {
    cause: "Invalid retained-result read request.",
    message:
      "Invalid result.read request. Code is not accepted; offset must be nonnegative and limit 1..30000.",
  },
  unavailable: {
    cause: "Retained result unavailable.",
    message:
      "Retained result unavailable, evicted, or revoked. No execution was run. Do not replay mutations to recover output.",
  },
  "invalid-offset": {
    cause: "Invalid retained-result offset.",
    message:
      "Invalid result offset: use a UTF-16 code-point boundary within the retained text. No execution was run.",
  },
  "page-budget": {
    cause: "The output budget or limit cannot fit a result page.",
    message:
      "Result page unavailable: output budget or limit cannot fit metadata and one code point. No execution was run.",
  },
  revoked: {
    cause: "Retained result was revoked.",
    message: "Retained result revoked. No execution was run.",
  },
} as const;

/** Structural replay bounds. Page ordering and identity still belong to each UI consumer. */
const OffsetSchema = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const ResultIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const ResultPageFields = {
  status: Schema.Literal("page"),
  id: ResultIdSchema,
  originalOutcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
  offset: OffsetSchema,
  end: OffsetSchema,
  next: Schema.NullOr(OffsetSchema),
  total: OffsetSchema,
};

export const ResultReadPresentationSchema = Schema.Union([
  Schema.Struct(ResultPageFields),
  Schema.Struct({
    status: Schema.Literal("error"),
    code: Schema.Literals([
      "invalid-input",
      "unavailable",
      "invalid-offset",
      "page-budget",
      "revoked",
    ]),
  }),
]);

export const InitialPreviewPresentationSchema = Schema.Struct({
  ...ResultPageFields,
  originalOutcome: Schema.Literal("succeeded"),
  kind: Schema.Literal("output"),
  receiptMode: Schema.Literals(["none", "read-only", "full"]),
});

export interface ResultPagePresentation {
  readonly status: "page";
  readonly id: string;
  readonly originalOutcome: ExecutionOutcome;
  readonly offset: number;
  readonly end: number;
  readonly next: number | null;
  readonly total: number;
}

/** Metadata for the first retained-output page returned by the execution call itself. */
export interface InitialPreviewPresentation extends ResultPagePresentation {
  readonly originalOutcome: "succeeded";
  readonly kind: "output";
  readonly receiptMode: "none" | "read-only" | "full";
}

export type ResultReadPresentation =
  | ResultPagePresentation
  | { readonly status: "error"; readonly code: keyof typeof resultReadFailures };

export interface ResultReadProjection {
  readonly text: string;
  readonly presentation: ResultReadPresentation;
}

/** Fixed owned reasons, separate from guest output and the original execution outcome. */
export const resultReadFailure = (
  code: keyof typeof resultReadFailures,
  maxBytes: number,
): ResultReadProjection => ({
  text: clampModelVisibleText(resultReadFailures[code].message, maxBytes),
  presentation: { status: "error", code },
});
